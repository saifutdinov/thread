package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
)

// Avatars and group photos are end-to-end encrypted like group titles: the
// browser seals a small picture with the chat key and the server keeps the
// sealed bytes. A user's avatar is sealed once per chat they are in, with
// AAD a:<chat>:<user>:<epoch> so the server cannot pass it off as someone
// else's; a group photo uses p:<chat>:<epoch>. The chat list carries only
// versions, the pictures are fetched when a version changes.

const maxPicture = 96 << 10

type picture struct {
	Epoch int    `json:"epoch"`
	V     int64  `json:"v"`
	Body  []byte `json:"body"` // nil: removed
}

// handleSetAvatar stores the caller's avatar in the given chats. A new
// picture gets a new version; copy=true fills chats that lag behind the
// current version (joined later, or re-keyed) without bumping it, and only
// if v still is the current version: a copy racing a newer upload from
// another device would otherwise store the old picture under the new one.
func (s *Server) handleSetAvatar(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Copy  bool  `json:"copy"`
		V     int64 `json:"v"` // copy: the version being copied
		Items []struct {
			Chat  int64  `json:"chat"`
			Epoch int    `json:"epoch"`
			Body  []byte `json:"body"`
		} `json:"items"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Items) == 0 || len(req.Items) > 500 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	ctx := r.Context()
	var v int64
	err := inTx(ctx, s.db, func(tx *sql.Tx) error {
		if req.Copy {
			if err := tx.QueryRowContext(ctx, `SELECT avatar_v FROM users WHERE id = ?`, a.UserID).Scan(&v); err != nil {
				return err
			}
			if v == 0 {
				return errBadRequest
			}
			if v != req.V {
				return errStale
			}
		} else {
			v = now()
			if _, err := tx.ExecContext(ctx, `UPDATE users SET avatar_v = ? WHERE id = ?`, v, a.UserID); err != nil {
				return err
			}
		}
		for _, it := range req.Items {
			if err := checkPicture(ctx, tx, it.Chat, a.UserID, it.Epoch, it.Body); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE members SET avatar = ?, avatar_epoch = ?, avatar_v = ? WHERE chat_id = ? AND user_id = ?`,
				it.Body, it.Epoch, v, it.Chat, a.UserID); err != nil {
				return err
			}
		}
		return nil
	})
	if s.writeErr(w, err) {
		return
	}
	for _, it := range req.Items {
		s.chatChanged(ctx, it.Chat)
	}
	writeJSON(w, http.StatusOK, map[string]any{"v": v})
}

// checkPicture: the caller is in the chat, the picture is small and sealed
// with a key epoch the chat has.
func checkPicture(ctx context.Context, tx *sql.Tx, chatID, userID int64, epoch int, body []byte) error {
	var cur int
	err := tx.QueryRowContext(ctx, `SELECT c.epoch FROM chats c JOIN members m ON m.chat_id = c.id AND m.user_id = ? WHERE c.id = ?`,
		userID, chatID).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotMember
	}
	if err != nil {
		return err
	}
	if len(body) > maxPicture || (body != nil && (epoch < 1 || epoch > cur)) {
		return errBadRequest
	}
	return nil
}

func (s *Server) handleGetAvatar(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	user, err := strconv.ParseInt(r.PathValue("user"), 10, 64)
	if err != nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	var p picture
	err = s.db.QueryRowContext(r.Context(), `SELECT t.avatar_epoch, t.avatar_v, t.avatar FROM members t
		JOIN members me ON me.chat_id = t.chat_id AND me.user_id = ?
		WHERE t.chat_id = ? AND t.user_id = ?`, a.UserID, chatID, user).Scan(&p.Epoch, &p.V, &p.Body)
	s.writePicture(w, p, err)
}

// handleSetPhoto sets or removes a group's photo; any member may.
func (s *Server) handleSetPhoto(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var req struct {
		Epoch int    `json:"epoch"`
		Body  []byte `json:"body"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	ctx := r.Context()
	err := inTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := checkPicture(ctx, tx, chatID, a.UserID, req.Epoch, req.Body); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE chats SET photo = ?, photo_epoch = ?, photo_v = ? WHERE id = ? AND kind = 'group'`,
			req.Body, req.Epoch, now(), chatID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errBadRequest // direct chats show the partner's avatar instead
		}
		return nil
	})
	if s.writeErr(w, err) {
		return
	}
	s.chatChanged(ctx, chatID)
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *Server) handleGetPhoto(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := pathID(r)
	var p picture
	err := s.db.QueryRowContext(r.Context(), `SELECT c.photo_epoch, c.photo_v, c.photo FROM chats c
		JOIN members me ON me.chat_id = c.id AND me.user_id = ? WHERE c.id = ?`, a.UserID, chatID).Scan(&p.Epoch, &p.V, &p.Body)
	s.writePicture(w, p, err)
}

func (s *Server) writePicture(w http.ResponseWriter, p picture, err error) {
	if errors.Is(err, sql.ErrNoRows) || (err == nil && p.Body == nil) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}
