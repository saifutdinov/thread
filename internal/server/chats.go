package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"
)

type member struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	LastRead int64  `json:"last_read"`
	Online   bool   `json:"online"`
	LastSeen int64  `json:"last_seen"` // 0 = hidden ("recently")
	AvatarV  int64  `json:"avatar_v,omitempty"`
	// AvatarEpoch tells the owner when their sealed copy is older than the
	// chat key (a re-invited direct chat): their client re-seals it.
	AvatarEpoch int `json:"avatar_epoch,omitempty"`
	// Invitee: the caller invited this person, so can make them a recovery link.
	Invitee bool `json:"invitee,omitempty"`
	// Since: the first key epoch this person holds (0 = from the start).
	// Their devices get no older keys: a direct chat re-used for someone
	// new keeps the earlier conversation from them.
	Since int `json:"since,omitempty"`
}

type chat struct {
	ID          int64    `json:"id"`
	Kind        string   `json:"kind"`
	Title       []byte   `json:"title,omitempty"`
	TitleEpoch  int      `json:"title_epoch"`
	Epoch       int      `json:"epoch"`
	Rotate      bool     `json:"rotate"`
	ClearedUpto int64    `json:"cleared_upto"`
	CreatedBy   int64    `json:"created_by"`
	CreatedAt   int64    `json:"created_at"`
	Unread      int      `json:"unread"`
	Members     []member `json:"members"`
	Last        *message `json:"last,omitempty"`
	NeedsKey    []int64  `json:"needs_key,omitempty"` // partner devices asking for this chat's key
	Pinned      int64    `json:"pinned,omitempty"`
	PinnedMsg   *message `json:"pinned_msg,omitempty"`
	PhotoV      int64    `json:"photo_v,omitempty"`
}

type reaction struct {
	User  int64  `json:"user"`
	Epoch int    `json:"epoch"`
	Body  []byte `json:"body"`
}

type message struct {
	ID        int64      `json:"id"`
	Chat      int64      `json:"chat"`
	User      int64      `json:"user"`
	Device    int64      `json:"device"`
	ClientID  string     `json:"cid"`
	Epoch     int        `json:"epoch"`
	Body      []byte     `json:"body,omitempty"`
	Sig       []byte     `json:"sig,omitempty"`
	ReplyTo   int64      `json:"reply_to,omitempty"`
	Media     bool       `json:"media,omitempty"`
	Seq       int64      `json:"seq"`
	At        int64      `json:"at"`
	Edited    int64      `json:"edited,omitempty"`
	Deleted   bool       `json:"deleted,omitempty"`
	Reactions []reaction `json:"reactions,omitempty"`
}

const msgCols = `id, chat_id, user_id, device_id, client_id, epoch, body, sig, reply_to, has_media, seq, created_at, edited_at, deleted`

func scanMessages(rows *sql.Rows) ([]*message, error) {
	defer rows.Close()
	var out []*message
	for rows.Next() {
		m := &message{}
		if err := rows.Scan(&m.ID, &m.Chat, &m.User, &m.Device, &m.ClientID, &m.Epoch, &m.Body, &m.Sig,
			&m.ReplyTo, &m.Media, &m.Seq, &m.At, &m.Edited, &m.Deleted); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Server) withReactions(ctx context.Context, msgs []*message) error {
	if len(msgs) == 0 {
		return nil
	}
	byID := map[int64]*message{}
	ids := make([]int64, len(msgs))
	for i, m := range msgs {
		byID[m.ID], ids[i] = m, m.ID
	}
	in, args := placeholders(ids)
	rows, err := s.db.QueryContext(ctx, `SELECT message_id, user_id, epoch, body FROM reactions WHERE message_id IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var rc reaction
		if err := rows.Scan(&id, &rc.User, &rc.Epoch, &rc.Body); err != nil {
			return err
		}
		byID[id].Reactions = append(byID[id].Reactions, rc)
	}
	return rows.Err()
}

func (s *Server) loadMessage(ctx context.Context, id int64) (*message, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+msgCols+` FROM messages WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	msgs, err := scanMessages(rows)
	if err != nil {
		return nil, err
	}
	if len(msgs) == 0 {
		return nil, sql.ErrNoRows
	}
	return msgs[0], s.withReactions(ctx, msgs)
}

// handleChats is the chat list: everything the sidebar needs in one call.
func (s *Server) handleChats(w http.ResponseWriter, r *http.Request, a *Auth) {
	ctx := r.Context()
	// rotate also when the key outlived keyMaxAge: chatEpoch refuses it.
	rows, err := s.db.QueryContext(ctx, `SELECT c.id, c.kind, c.title, c.title_epoch, c.epoch, c.rotate OR c.epoch_at < ?, c.cleared_upto,
		COALESCE(c.created_by, 0), c.created_at, c.pinned, c.photo_v,
		(SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.id > mb.last_read AND m.deleted = 0 AND m.user_id <> ?)
		FROM chats c JOIN members mb ON mb.chat_id = c.id AND mb.user_id = ?`, now()-keyMaxAge.Milliseconds(), a.UserID, a.UserID)
	if err != nil {
		s.internal(w, err)
		return
	}
	chats := []*chat{}
	byID := map[int64]*chat{}
	for rows.Next() {
		c := &chat{Members: []member{}}
		if err := rows.Scan(&c.ID, &c.Kind, &c.Title, &c.TitleEpoch, &c.Epoch, &c.Rotate, &c.ClearedUpto,
			&c.CreatedBy, &c.CreatedAt, &c.Pinned, &c.PhotoV, &c.Unread); err != nil {
			rows.Close()
			s.internal(w, err)
			return
		}
		chats = append(chats, c)
		byID[c.ID] = c
	}
	rows.Close()
	if len(chats) == 0 {
		writeJSON(w, http.StatusOK, chats)
		return
	}
	ids := make([]int64, len(chats))
	for i, c := range chats {
		ids[i] = c.ID
	}
	in, args := placeholders(ids)

	rows, err = s.db.QueryContext(ctx, `SELECT mb.chat_id, u.id, u.name, mb.last_read, u.hide_online, u.last_seen, mb.avatar_v, mb.avatar_epoch,
		COALESCE(u.invited_by, 0) = ?, mb.since_epoch
		FROM members mb JOIN users u ON u.id = mb.user_id WHERE mb.chat_id IN (`+in+`) ORDER BY mb.joined_at`, append([]any{a.UserID}, args...)...)
	if err != nil {
		s.internal(w, err)
		return
	}
	for rows.Next() {
		var chatID int64
		var m member
		var hide bool
		if err := rows.Scan(&chatID, &m.ID, &m.Name, &m.LastRead, &hide, &m.LastSeen, &m.AvatarV, &m.AvatarEpoch, &m.Invitee, &m.Since); err != nil {
			rows.Close()
			s.internal(w, err)
			return
		}
		s.presence(&m, hide)
		byID[chatID].Members = append(byID[chatID].Members, m)
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `SELECT `+msgCols+` FROM messages WHERE id IN (
		SELECT MAX(id) FROM messages WHERE chat_id IN (`+in+`) AND deleted = 0 GROUP BY chat_id)`, args...)
	if err != nil {
		s.internal(w, err)
		return
	}
	last, err := scanMessages(rows)
	if err != nil {
		s.internal(w, err)
		return
	}
	for _, m := range last {
		byID[m.Chat].Last = m
	}

	// Pinned messages ride along so the pin bar shows without a fetch.
	rows, err = s.db.QueryContext(ctx, `SELECT `+msgCols+` FROM messages WHERE deleted = 0 AND id IN (
		SELECT pinned FROM chats WHERE id IN (`+in+`) AND pinned > 0)`, args...)
	if err != nil {
		s.internal(w, err)
		return
	}
	pinned, err := scanMessages(rows)
	if err != nil {
		s.internal(w, err)
		return
	}
	for _, m := range pinned {
		byID[m.Chat].PinnedMsg = m
	}

	// Partner devices (recovery requested) missing this chat's current key.
	rows, err = s.db.QueryContext(ctx, `SELECT c.id, d.id FROM chats c
		JOIN members mb ON mb.chat_id = c.id JOIN devices d ON d.user_id = mb.user_id
		WHERE c.id IN (`+in+`) AND d.recovery = 1 AND d.status <> 'revoked' AND d.user_id <> ?
		AND NOT EXISTS (SELECT 1 FROM chat_keys k WHERE k.chat_id = c.id AND k.epoch = c.epoch AND k.device_id = d.id)`,
		append(args, a.UserID)...)
	if err != nil {
		s.internal(w, err)
		return
	}
	for rows.Next() {
		var chatID, deviceID int64
		if err := rows.Scan(&chatID, &deviceID); err != nil {
			rows.Close()
			s.internal(w, err)
			return
		}
		byID[chatID].NeedsKey = append(byID[chatID].NeedsKey, deviceID)
	}
	rows.Close()
	writeJSON(w, http.StatusOK, chats)
}

func (s *Server) presence(m *member, hidden bool) {
	if hidden {
		m.LastSeen = 0
		return
	}
	m.Online = s.hub.online(m.ID)
}

// handleMessages pages backwards: ?before=<id>&limit=50, ?media=1 for the
// chat profile gallery.
func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	if !isMember(r.Context(), s.db, chatID, a.UserID) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if before <= 0 {
		before = 1 << 62
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	q := `SELECT ` + msgCols + ` FROM messages WHERE chat_id = ? AND id < ?`
	if r.URL.Query().Get("media") == "1" {
		q += ` AND has_media = 1 AND deleted = 0`
	}
	rows, err := s.db.QueryContext(r.Context(), q+` ORDER BY id DESC LIMIT ?`, chatID, before, limit)
	if err != nil {
		s.internal(w, err)
		return
	}
	msgs, err := scanMessages(rows)
	if err == nil {
		err = s.withReactions(r.Context(), msgs)
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if msgs == nil {
		msgs = []*message{}
	}
	writeJSON(w, http.StatusOK, msgs)
}

// handleSync returns messages changed after a seq cursor, for catching up
// after a dropped WebSocket.
func (s *Server) handleSync(w http.ResponseWriter, r *http.Request, a *Auth) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	// Cursor first: a change committed while we read is then re-sent next
	// time instead of skipped.
	var seq int64
	if err := s.db.QueryRowContext(r.Context(), `SELECT seq FROM counter WHERE id = 1`).Scan(&seq); err != nil {
		s.internal(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT `+msgCols+` FROM messages
		WHERE seq > ? AND chat_id IN (SELECT chat_id FROM members WHERE user_id = ?) ORDER BY seq LIMIT 500`, since, a.UserID)
	if err != nil {
		s.internal(w, err)
		return
	}
	msgs, err := scanMessages(rows)
	if err == nil {
		err = s.withReactions(r.Context(), msgs)
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if len(msgs) == 500 {
		seq = msgs[len(msgs)-1].Seq // client reloads anyway; keep the cursor honest
	}
	if msgs == nil {
		msgs = []*message{}
	}
	// full=true: more than one page changed, the client reloads instead.
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "seq": seq, "full": len(msgs) == 500})
}

type sealed struct {
	Epoch int    `json:"epoch"`
	Body  []byte `json:"body"`
	Sig   []byte `json:"sig"`
}

// keyMaxAge bounds how long one chat key protects new messages: a key
// that leaks only exposes its own week.
const keyMaxAge = 7 * 24 * time.Hour

// chatEpoch reports the epoch new content must use, or errRotate when a
// member or device changed, or the key is older than keyMaxAge, and the
// next sender has to rotate it first.
func chatEpoch(ctx context.Context, tx *sql.Tx, chatID int64) (int, error) {
	var epoch int
	var rotate bool
	var since int64
	if err := tx.QueryRowContext(ctx, `SELECT epoch, rotate, epoch_at FROM chats WHERE id = ?`, chatID).Scan(&epoch, &rotate, &since); err != nil {
		return 0, err
	}
	if rotate || now()-since > keyMaxAge.Milliseconds() {
		return 0, errRotate
	}
	return epoch, nil
}

var (
	errRotate = errors.New("rotate")
	errEpoch  = errors.New("epoch")
	errStale  = errors.New("stale")
)

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var req struct {
		sealed
		ClientID string   `json:"cid"`
		ReplyTo  int64    `json:"reply_to"`
		Media    []string `json:"media"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.ClientID == "" || len(req.ClientID) > 64 || len(req.Body) == 0 || len(req.Body) > 64<<10 || len(req.Sig) != 64 || len(req.Media) > 20 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	var id int64
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		if !isMember(r.Context(), tx, chatID, a.UserID) {
			return errNotMember
		}
		epoch, err := chatEpoch(r.Context(), tx, chatID)
		if err != nil {
			return err
		}
		if req.Epoch != epoch {
			return errEpoch
		}
		// Idempotent retry: same device + client id returns the stored message.
		if err := tx.QueryRowContext(r.Context(), `SELECT id FROM messages WHERE device_id = ? AND client_id = ?`,
			a.DeviceID, req.ClientID).Scan(&id); err == nil {
			return nil
		}
		seq, err := nextSeq(r.Context(), tx)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(r.Context(), `INSERT INTO messages (chat_id, user_id, device_id, client_id, epoch, body, sig,
			reply_to, has_media, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			chatID, a.UserID, a.DeviceID, req.ClientID, req.Epoch, req.Body, req.Sig, req.ReplyTo, len(req.Media) > 0, seq, now())
		if err != nil {
			return err
		}
		id, _ = res.LastInsertId()
		for _, mid := range req.Media {
			res, err := tx.ExecContext(r.Context(), `UPDATE media SET message_id = ? WHERE id = ? AND chat_id = ? AND uploader = ? AND message_id IS NULL`,
				id, mid, chatID, a.UserID)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n != 1 {
				return errBadRequest
			}
		}
		// Sending implies having read everything before.
		_, err = tx.ExecContext(r.Context(), `UPDATE members SET last_read = ? WHERE chat_id = ? AND user_id = ?`, id, chatID, a.UserID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	m, err := s.loadMessage(r.Context(), id)
	if err != nil {
		s.internal(w, err)
		return
	}
	s.messageChanged(r.Context(), m)
	s.push.notifyMessage(r.Context(), m, a)
	writeJSON(w, http.StatusOK, m)
}

// writeErr maps domain errors to responses; true means a response was sent.
func (s *Server) writeErr(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, errNotMember), errors.Is(err, sql.ErrNoRows):
		fail(w, http.StatusNotFound, "not_found")
	case errors.Is(err, errRotate):
		fail(w, http.StatusConflict, "rotate")
	case errors.Is(err, errEpoch):
		fail(w, http.StatusConflict, "epoch")
	case errors.Is(err, errStale):
		fail(w, http.StatusConflict, "stale")
	case errors.Is(err, errDevices):
		fail(w, http.StatusConflict, "devices_changed")
	case errors.Is(err, errForbidden):
		fail(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, errBadRequest):
		fail(w, http.StatusBadRequest, "bad_request")
	default:
		s.internal(w, err)
	}
	return true
}

var errForbidden = errors.New("forbidden")

// messageChat loads a message's chat after checking the caller is a member.
func messageChat(ctx context.Context, tx *sql.Tx, msgID, userID int64) (chatID, author int64, kind string, creator int64, err error) {
	err = tx.QueryRowContext(ctx, `SELECT m.chat_id, m.user_id, c.kind, COALESCE(c.created_by, 0) FROM messages m
		JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND m.deleted = 0`, msgID).Scan(&chatID, &author, &kind, &creator)
	if err == nil && !isMember(ctx, tx, chatID, userID) {
		err = errNotMember
	}
	return
}

func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request, a *Auth) {
	msgID, _ := pathID(r)
	var req sealed
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Body) == 0 || len(req.Body) > 64<<10 || len(req.Sig) != 64 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		chatID, author, _, _, err := messageChat(r.Context(), tx, msgID, a.UserID)
		if err != nil {
			return err
		}
		if author != a.UserID {
			return errForbidden
		}
		epoch, err := chatEpoch(r.Context(), tx, chatID)
		if err != nil {
			return err
		}
		if req.Epoch != epoch {
			return errEpoch
		}
		seq, err := nextSeq(r.Context(), tx)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE messages SET epoch = ?, body = ?, sig = ?, device_id = ?, edited_at = ?, seq = ? WHERE id = ?`,
			req.Epoch, req.Body, req.Sig, a.DeviceID, now(), seq, msgID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	s.afterMessageChange(w, r, msgID)
}

func (s *Server) afterMessageChange(w http.ResponseWriter, r *http.Request, msgID int64) {
	m, err := s.loadMessage(r.Context(), msgID)
	if err != nil {
		s.internal(w, err)
		return
	}
	s.messageChanged(r.Context(), m)
	writeJSON(w, http.StatusOK, m)
}

// handleDeleteMessage deletes for everyone, Telegram style: own messages
// anywhere, any message in a direct chat, any message for a group creator.
// The row stays as a content-free tombstone so /api/sync can report it.
func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request, a *Auth) {
	msgID, _ := pathID(r)
	var media []string
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		_, author, kind, creator, err := messageChat(r.Context(), tx, msgID, a.UserID)
		if err != nil {
			return err
		}
		if author != a.UserID && kind != "direct" && creator != a.UserID {
			return errForbidden
		}
		seq, err := nextSeq(r.Context(), tx)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE messages SET body = NULL, sig = NULL, has_media = 0, deleted = 1, seq = ? WHERE id = ?`, seq, msgID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM reactions WHERE message_id = ?`, msgID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE chats SET pinned = 0 WHERE pinned = ?`, msgID); err != nil {
			return err
		}
		media, err = txMediaIDs(r.Context(), tx, `SELECT id FROM media WHERE message_id = ?`, msgID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	if err := s.deleteMedia(r.Context(), media); err != nil {
		s.log.Error("delete media", "err", err)
	}
	s.afterMessageChange(w, r, msgID)
}

// handleClearHistory wipes a chat's messages for everyone: any member of a
// direct chat, only the creator of a group.
func (s *Server) handleClearHistory(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var media []string
	var upto int64
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		var kind string
		var creator int64
		if err := tx.QueryRowContext(r.Context(), `SELECT kind, COALESCE(created_by, 0) FROM chats WHERE id = ?`, chatID).Scan(&kind, &creator); err != nil {
			return err
		}
		if !isMember(r.Context(), tx, chatID, a.UserID) {
			return errNotMember
		}
		if kind != "direct" && creator != a.UserID {
			return errForbidden
		}
		if err := tx.QueryRowContext(r.Context(), `SELECT COALESCE(MAX(id), 0) FROM messages WHERE chat_id = ?`, chatID).Scan(&upto); err != nil {
			return err
		}
		var err error
		if media, err = txMediaIDs(r.Context(), tx, `SELECT id FROM media WHERE chat_id = ? AND message_id IS NOT NULL`, chatID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM messages WHERE chat_id = ?`, chatID); err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE chats SET cleared_upto = ?, pinned = 0 WHERE id = ?`, upto, chatID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	if err := s.deleteMedia(r.Context(), media); err != nil {
		s.log.Error("delete media", "err", err)
	}
	s.chatChanged(r.Context(), chatID)
	writeJSON(w, http.StatusOK, map[string]any{"cleared_upto": upto})
}

func (s *Server) handleReact(w http.ResponseWriter, r *http.Request, a *Auth) {
	msgID, _ := pathID(r)
	var req sealed
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Body) == 0 || len(req.Body) > 256 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	s.setReaction(w, r, a, msgID, func(ctx context.Context, tx *sql.Tx, chatID int64) error {
		epoch, err := chatEpoch(ctx, tx, chatID)
		if err != nil {
			return err
		}
		if req.Epoch != epoch {
			return errEpoch
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO reactions (message_id, user_id, epoch, body) VALUES (?, ?, ?, ?)
			ON CONFLICT (message_id, user_id) DO UPDATE SET epoch = excluded.epoch, body = excluded.body`, msgID, a.UserID, req.Epoch, req.Body)
		return err
	})
}

func (s *Server) handleUnreact(w http.ResponseWriter, r *http.Request, a *Auth) {
	msgID, _ := pathID(r)
	s.setReaction(w, r, a, msgID, func(ctx context.Context, tx *sql.Tx, _ int64) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE message_id = ? AND user_id = ?`, msgID, a.UserID)
		return err
	})
}

func (s *Server) setReaction(w http.ResponseWriter, r *http.Request, a *Auth, msgID int64, change func(context.Context, *sql.Tx, int64) error) {
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		chatID, _, _, _, err := messageChat(r.Context(), tx, msgID, a.UserID)
		if err != nil {
			return err
		}
		if err := change(r.Context(), tx, chatID); err != nil {
			return err
		}
		seq, err := nextSeq(r.Context(), tx)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE messages SET seq = ? WHERE id = ?`, seq, msgID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	s.afterMessageChange(w, r, msgID)
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var req struct {
		ID int64 `json:"id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	res, err := s.db.ExecContext(r.Context(), `UPDATE members SET last_read = MAX(last_read, ?) WHERE chat_id = ? AND user_id = ?`,
		req.ID, chatID, a.UserID)
	if err != nil {
		s.internal(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 1 {
		if ids, err := chatUserIDs(r.Context(), s.db, chatID); err == nil {
			s.hub.toUsers(ids, event{"t": "read", "c": chatID, "u": a.UserID, "id": req.ID})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handlePin pins one message per chat (any member may, like a family
// group would expect); a zero id unpins.
func (s *Server) handlePin(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var req struct {
		ID int64 `json:"id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		if !isMember(r.Context(), tx, chatID, a.UserID) {
			return errNotMember
		}
		if req.ID != 0 {
			var one int
			if err := tx.QueryRowContext(r.Context(), `SELECT 1 FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0`,
				req.ID, chatID).Scan(&one); err != nil {
				return errBadRequest
			}
		}
		_, err := tx.ExecContext(r.Context(), `UPDATE chats SET pinned = ? WHERE id = ?`, req.ID, chatID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	s.chatChanged(r.Context(), chatID)
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleLeaveChat removes the caller; the last one out deletes the chat.
// Remaining members must rotate the key before writing again.
func (s *Server) handleLeaveChat(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var media []string
	var gone bool
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		if !isMember(r.Context(), tx, chatID, a.UserID) {
			return errNotMember
		}
		for _, q := range []string{
			`DELETE FROM members WHERE chat_id = ? AND user_id = ?`,
			`DELETE FROM invites WHERE chat_id = ? AND created_by = ?`,
			`DELETE FROM chat_keys WHERE chat_id = ? AND device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		} {
			if _, err := tx.ExecContext(r.Context(), q, chatID, a.UserID); err != nil {
				return err
			}
		}
		var left int
		if err := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM members WHERE chat_id = ?`, chatID).Scan(&left); err != nil {
			return err
		}
		if left > 0 {
			_, err := tx.ExecContext(r.Context(), `UPDATE chats SET rotate = 1 WHERE id = ?`, chatID)
			return err
		}
		gone = true
		var err error
		if media, err = txMediaIDs(r.Context(), tx, `SELECT id FROM media WHERE chat_id = ?`, chatID); err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), `DELETE FROM chats WHERE id = ?`, chatID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	if gone {
		if err := s.deleteMedia(r.Context(), media); err != nil {
			s.log.Error("delete media", "err", err)
		}
	} else {
		s.chatChanged(r.Context(), chatID)
	}
	s.hub.toUsers([]int64{a.UserID}, event{"t": "chat", "c": chatID})
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleRotate installs the next key epoch, wrapped for every active
// device of every member.
func (s *Server) handleRotate(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var req struct {
		Epoch int          `json:"epoch"`
		Keys  []wrappedKey `json:"keys"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		if !isMember(r.Context(), tx, chatID, a.UserID) {
			return errNotMember
		}
		if !isKeyHolder(r.Context(), tx, chatID, a.DeviceID) {
			return errForbidden
		}
		var epoch int
		if err := tx.QueryRowContext(r.Context(), `SELECT epoch FROM chats WHERE id = ?`, chatID).Scan(&epoch); err != nil {
			return err
		}
		if req.Epoch != epoch+1 {
			return errEpoch
		}
		if err := s.storeEpochKeys(r.Context(), tx, chatID, req.Epoch, req.Keys); err != nil {
			return err
		}
		_, err := tx.ExecContext(r.Context(), `UPDATE chats SET epoch = ?, rotate = 0, epoch_at = ? WHERE id = ?`, req.Epoch, now(), chatID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	s.chatChanged(r.Context(), chatID)
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleChatDevices lists the encryption keys a rotation must wrap for,
// or with ?all=1 every active device of the members (safety codes).
func (s *Server) handleChatDevices(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	if !isMember(r.Context(), s.db, chatID, a.UserID) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	q := keyHoldersSQL
	if r.URL.Query().Get("all") == "1" {
		q = `SELECT d.id, d.user_id, d.enc_pub, d.sig_pub FROM devices d JOIN members m ON m.user_id = d.user_id
			WHERE m.chat_id = ? AND d.status = 'active'`
	}
	rows, err := s.db.QueryContext(r.Context(), q, chatID)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, user int64
		var enc, sig []byte
		if err := rows.Scan(&id, &user, &enc, &sig); err != nil {
			s.internal(w, err)
			return
		}
		out = append(out, map[string]any{"id": id, "user": user, "enc_pub": enc, "sig_pub": sig})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleKeys returns every chat key wrapped for the calling device.
func (s *Server) handleKeys(w http.ResponseWriter, r *http.Request, a *Auth) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT chat_id, epoch, wrapped FROM chat_keys WHERE device_id = ?`, a.DeviceID)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	out := []wrappedKey{}
	for rows.Next() {
		k := wrappedKey{Device: a.DeviceID}
		if err := rows.Scan(&k.Chat, &k.Epoch, &k.Wrapped); err != nil {
			s.internal(w, err)
			return
		}
		out = append(out, k)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleShareKeys lets a device pass chat keys it holds to the caller's
// other devices (after joining a chat through an invite on one of them).
func (s *Server) handleShareKeys(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Keys []wrappedKey `json:"keys"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		for _, k := range req.Keys {
			var epoch int
			if err := tx.QueryRowContext(r.Context(), `SELECT epoch FROM chats WHERE id = ?`, k.Chat).Scan(&epoch); err != nil {
				return errBadRequest
			}
			var owner int64
			var status string
			if err := tx.QueryRowContext(r.Context(), `SELECT user_id, status FROM devices WHERE id = ?`, k.Device).Scan(&owner, &status); err != nil {
				return errBadRequest
			}
			if owner != a.UserID || status != "active" || k.Epoch < 1 || k.Epoch > epoch || len(k.Wrapped) != wrappedSize ||
				!isMember(r.Context(), tx, k.Chat, a.UserID) {
				return errBadRequest
			}
			if !isKeyHolder(r.Context(), tx, k.Chat, a.DeviceID) {
				return errForbidden
			}
			if _, err := tx.ExecContext(r.Context(), `INSERT OR IGNORE INTO chat_keys (chat_id, epoch, device_id, wrapped) VALUES (?, ?, ?, ?)`,
				k.Chat, k.Epoch, k.Device, k.Wrapped); err != nil {
				return err
			}
		}
		return nil
	})
	if s.writeErr(w, err) {
		return
	}
	s.hub.toUsers([]int64{a.UserID}, event{"t": "keys"})
	writeJSON(w, http.StatusOK, map[string]any{})
}

// --- fan-out ---

func (s *Server) messageChanged(ctx context.Context, m *message) {
	ids, err := chatUserIDs(ctx, s.db, m.Chat)
	if err != nil {
		s.log.Error("fan-out", "err", err)
		return
	}
	s.hub.toUsers(ids, event{"t": "msg", "m": m})
}

// chatChanged tells members to refetch the chat list (membership, epoch,
// cleared history).
func (s *Server) chatChanged(ctx context.Context, chatID int64) {
	ids, err := chatUserIDs(ctx, s.db, chatID)
	if err != nil {
		s.log.Error("fan-out", "err", err)
		return
	}
	s.hub.toUsers(ids, event{"t": "chat", "c": chatID})
}

func (s *Server) broadcastUser(ctx context.Context, userID int64) {
	ids, err := contactIDs(ctx, s.db, userID)
	if err != nil {
		s.log.Error("fan-out", "err", err)
		return
	}
	s.hub.toUsers(append(ids, userID), event{"t": "user", "u": userID})
}
