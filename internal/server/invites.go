package server

import (
	"context"
	"crypto/hkdf"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"time"
)

// Invite links look like BASE_URL/#/i/<secret>. The fragment never reaches
// the server; the browser derives two keys from the secret:
//   auth = HKDF(secret, "connect/invite/auth")  -> sent on redeem, id = SHA-256(auth)
//   wrap = HKDF(secret, "connect/invite/wrap")  -> encrypts the chat-key bundle, browser only
// So the server can match a link without being able to read the chat.

const (
	inviteTTL   = 7 * 24 * time.Hour
	maxGroup    = 200
	wrappedSize = 65 + 12 + 48 // ephemeral P-256 point + IV + AES-GCM(32-byte key)
)

func inviteAuthKey(secret []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, secret, nil, "connect/invite/auth", 32)
}

// bootstrap prints a first-user registration link while nobody exists.
func (s *Server) bootstrap(ctx context.Context) error {
	var users int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		return err
	}
	if users > 0 {
		return nil
	}
	secret := randomBytes(32)
	auth, err := inviteAuthKey(secret)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO invites (id, max_uses, expires_at, created_at) VALUES (?, 1, ?, ?)`,
		sha(auth), time.Now().Add(24*time.Hour).UnixMilli(), now()); err != nil {
		return err
	}
	s.log.Info("no users yet, first-user invite (valid 24h, one use)", "url", s.cfg.BaseURL+"/#/i/"+b64(secret))
	return nil
}

type invite struct {
	ChatID    sql.NullInt64
	CreatedBy sql.NullInt64
	Bundle    []byte
	MaxUses   int
	Uses      int
}

var errInvite = errors.New("invite")

func loadInvite(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, key []byte) (*invite, []byte, error) {
	id := sha(key)
	var inv invite
	err := q.QueryRowContext(ctx, `SELECT chat_id, created_by, bundle, max_uses, uses FROM invites
		WHERE id = ? AND expires_at > ? AND uses < max_uses`, id, now()).
		Scan(&inv.ChatID, &inv.CreatedBy, &inv.Bundle, &inv.MaxUses, &inv.Uses)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, id, errInvite
	}
	return &inv, id, err
}

func (s *Server) handlePeek(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key []byte `json:"key"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !s.auth.allow(s.clientIP(r)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	inv, _, err := loadInvite(r.Context(), s.db, req.Key)
	if errors.Is(err, errInvite) {
		fail(w, http.StatusNotFound, "invite_invalid")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	out := map[string]any{"kind": "register", "bundle": inv.Bundle}
	if inv.ChatID.Valid {
		var kind, inviter string
		var title []byte
		var titleEpoch, members int
		err := s.db.QueryRowContext(r.Context(), `SELECT c.kind, c.title, c.title_epoch,
			(SELECT COUNT(*) FROM members WHERE chat_id = c.id), COALESCE((SELECT name FROM users WHERE id = ?), '')
			FROM chats c WHERE c.id = ?`, inv.CreatedBy, inv.ChatID).Scan(&kind, &title, &titleEpoch, &members, &inviter)
		if err != nil {
			s.internal(w, err)
			return
		}
		out = map[string]any{"kind": kind, "chat_id": inv.ChatID.Int64, "title": title, "title_epoch": titleEpoch,
			"members": members, "inviter": inviter, "bundle": inv.Bundle}
		if a, err := s.session(r); err == nil {
			out["member"] = isMember(r.Context(), s.db, inv.ChatID.Int64, a.UserID)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleRedeem consumes one use of an invite. Without a session it
// registers a new user (name in, generated password out) with this browser
// as the first, already trusted device. With a session it joins the chat.
func (s *Server) handleRedeem(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key    []byte     `json:"key"`
		Name   string     `json:"name"`
		Device *devicePub `json:"device"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !s.auth.allow(s.clientIP(r)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	me, err := s.session(r)
	if err == nil && me.Status != "active" {
		fail(w, http.StatusForbidden, "device_pending")
		return
	}
	var password string
	var lookup []byte
	if me == nil {
		name, ok := cleanName(req.Name)
		if !ok {
			fail(w, http.StatusBadRequest, "bad_name")
			return
		}
		req.Name = name
		if req.Device == nil || !req.Device.valid() {
			fail(w, http.StatusBadRequest, "bad_device")
			return
		}
		// Hash outside the transaction: argon2 is slow and SQLite has one writer.
		password = newPassword()
		if lookup, err = s.lookupKey(r.Context(), password); err != nil {
			s.internal(w, err)
			return
		}
	}

	var chatID, deviceID int64
	var bundle []byte
	var joined bool
	err = inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		inv, id, err := loadInvite(r.Context(), tx, req.Key)
		if err != nil {
			return err
		}
		chatID, bundle = inv.ChatID.Int64, inv.Bundle
		userID := int64(0)
		if me != nil {
			if !inv.ChatID.Valid {
				return errAlreadyRegistered
			}
			userID = me.UserID
			if isMember(r.Context(), tx, chatID, userID) {
				return nil // already in: keep the use for someone else
			}
		} else {
			res, err := tx.ExecContext(r.Context(), `INSERT INTO users (name, pass_lookup, invited_by, created_at) VALUES (?, ?, ?, ?)`,
				req.Name, lookup, inv.CreatedBy, now())
			if err != nil {
				return err // a lookup collision is ~2^-37; the user just retries
			}
			userID, _ = res.LastInsertId()
			if deviceID, err = insertDevice(r.Context(), tx, userID, *req.Device, "active"); err != nil {
				return err
			}
			if err := s.startSession(r.Context(), w, tx, deviceID); err != nil {
				return err
			}
		}
		if inv.ChatID.Valid {
			if err := checkSeats(r.Context(), tx, chatID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(r.Context(), `INSERT INTO members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
				chatID, userID, now()); err != nil {
				return err
			}
			// The bundle was sealed when the link was made; a rotation since
			// then would lock the newcomer out of new messages. The next
			// writer rotates and includes the newcomer's devices.
			if _, err := tx.ExecContext(r.Context(), `UPDATE chats SET rotate = 1 WHERE id = ?`, chatID); err != nil {
				return err
			}
			joined = true
		}
		if inv.Uses+1 >= inv.MaxUses {
			_, err = tx.ExecContext(r.Context(), `DELETE FROM invites WHERE id = ?`, id)
		} else {
			_, err = tx.ExecContext(r.Context(), `UPDATE invites SET uses = uses + 1 WHERE id = ?`, id)
		}
		return err
	})
	switch {
	case errors.Is(err, errInvite):
		fail(w, http.StatusNotFound, "invite_invalid")
		return
	case errors.Is(err, errAlreadyRegistered):
		fail(w, http.StatusConflict, "already_registered")
		return
	case errors.Is(err, errChatFull):
		fail(w, http.StatusConflict, "chat_full")
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	if joined {
		s.chatChanged(r.Context(), chatID)
	}
	out := map[string]any{"chat_id": chatID, "bundle": bundle}
	if password != "" {
		out["password"], out["device_id"] = password, deviceID
	}
	writeJSON(w, http.StatusOK, out)
}

var (
	errAlreadyRegistered = errors.New("already registered")
	errChatFull          = errors.New("chat full")
)

func checkSeats(ctx context.Context, tx *sql.Tx, chatID int64) error {
	var kind string
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT kind, (SELECT COUNT(*) FROM members WHERE chat_id = c.id) FROM chats c WHERE id = ?`, chatID).
		Scan(&kind, &n); err != nil {
		return err
	}
	if (kind == "direct" && n >= 2) || n >= maxGroup {
		return errChatFull
	}
	return nil
}

type wrappedKey struct {
	Chat    int64  `json:"chat"`
	Epoch   int    `json:"epoch"`
	Device  int64  `json:"device"`
	Wrapped []byte `json:"wrapped"`
}

type newInvite struct {
	ID      []byte `json:"id"` // SHA-256 of the auth key, computed in the browser
	Bundle  []byte `json:"bundle"`
	MaxUses int    `json:"max_uses"`
}

func (n *newInvite) valid(kind string) bool {
	if len(n.ID) != 32 || len(n.Bundle) == 0 || len(n.Bundle) > 64<<10 {
		return false
	}
	if kind == "direct" {
		return n.MaxUses == 1
	}
	return n.MaxUses >= 1 && n.MaxUses <= maxGroup
}

func insertInvite(ctx context.Context, tx *sql.Tx, chatID, userID int64, n newInvite) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO invites (id, chat_id, created_by, bundle, max_uses, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, n.ID, chatID, userID, n.Bundle, n.MaxUses, time.Now().Add(inviteTTL).UnixMilli(), now())
	return err
}

// handleCreateChat creates a chat, its first key epoch (wrapped for every
// active device of the creator) and the invite link for it, atomically.
func (s *Server) handleCreateChat(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Kind   string       `json:"kind"`
		Title  []byte       `json:"title"`
		Keys   []wrappedKey `json:"keys"`
		Invite newInvite    `json:"invite"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if (req.Kind != "direct" && req.Kind != "group") || !req.Invite.valid(req.Kind) || len(req.Title) > 1024 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	var chatID int64
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		titleEpoch := 0
		if len(req.Title) > 0 {
			titleEpoch = 1
		}
		res, err := tx.ExecContext(r.Context(), `INSERT INTO chats (kind, title, title_epoch, created_by, created_at, epoch_at) VALUES (?, ?, ?, ?, ?, ?)`,
			req.Kind, req.Title, titleEpoch, a.UserID, now(), now())
		if err != nil {
			return err
		}
		chatID, _ = res.LastInsertId()
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`, chatID, a.UserID, now()); err != nil {
			return err
		}
		if err := s.storeEpochKeys(r.Context(), tx, chatID, 1, req.Keys); err != nil {
			return err
		}
		return insertInvite(r.Context(), tx, chatID, a.UserID, req.Invite)
	})
	if errors.Is(err, errDevices) {
		fail(w, http.StatusConflict, "devices_changed")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	s.hub.toUsers([]int64{a.UserID}, event{"t": "chat", "c": chatID})
	writeJSON(w, http.StatusOK, map[string]any{"chat_id": chatID})
}

var errDevices = errors.New("device set mismatch")

// storeEpochKeys requires one wrapped key per active device of every member:
// nobody is silently left unable to read, nobody extra gets the key.
func (s *Server) storeEpochKeys(ctx context.Context, tx *sql.Tx, chatID int64, epoch int, keys []wrappedKey) error {
	rows, err := tx.QueryContext(ctx, `SELECT d.id FROM devices d JOIN members m ON m.user_id = d.user_id
		WHERE m.chat_id = ? AND d.status = 'active'`, chatID)
	if err != nil {
		return err
	}
	want := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		want[id] = true
	}
	rows.Close()
	if len(keys) != len(want) {
		return errDevices
	}
	for _, k := range keys {
		if !want[k.Device] || len(k.Wrapped) != wrappedSize {
			return errDevices
		}
		delete(want, k.Device)
		if _, err := tx.ExecContext(ctx, `INSERT INTO chat_keys (chat_id, epoch, device_id, wrapped) VALUES (?, ?, ?, ?)`,
			chatID, epoch, k.Device, k.Wrapped); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, ok := pathID(r)
	var req newInvite
	if !ok || !readJSON(w, r, &req) {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		var kind string
		var creator sql.NullInt64
		if err := tx.QueryRowContext(r.Context(), `SELECT kind, created_by FROM chats WHERE id = ?`, chatID).Scan(&kind, &creator); err != nil {
			return errNotMember
		}
		if !isMember(r.Context(), tx, chatID, a.UserID) {
			return errNotMember
		}
		// Multi-use links are the group creator's call; everyone else hands
		// out single invites.
		if !req.valid(kind) || (req.MaxUses > 1 && creator.Int64 != a.UserID) {
			return errBadRequest
		}
		if err := checkSeats(r.Context(), tx, chatID); err != nil {
			return err
		}
		return insertInvite(r.Context(), tx, chatID, a.UserID, req)
	})
	switch {
	case errors.Is(err, errNotMember):
		fail(w, http.StatusNotFound, "not_found")
	case errors.Is(err, errBadRequest):
		fail(w, http.StatusBadRequest, "bad_request")
	case errors.Is(err, errChatFull):
		fail(w, http.StatusConflict, "chat_full")
	case err != nil:
		s.internal(w, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

var (
	errNotMember  = errors.New("not a member")
	errBadRequest = errors.New("bad request")
)

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, max_uses, uses, expires_at FROM invites
		WHERE chat_id = ? AND created_by = ? AND expires_at > ? ORDER BY created_at`, chatID, a.UserID, now())
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id []byte
		var maxUses, uses int
		var exp int64
		if err := rows.Scan(&id, &maxUses, &uses, &exp); err != nil {
			s.internal(w, err)
			return
		}
		out = append(out, map[string]any{"id": hex.EncodeToString(id), "max_uses": maxUses, "uses": uses, "expires_at": exp})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeleteInvite(w http.ResponseWriter, r *http.Request, a *Auth) {
	id, err := hex.DecodeString(r.PathValue("id"))
	if err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM invites WHERE id = ? AND created_by = ?`, id, a.UserID); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}
