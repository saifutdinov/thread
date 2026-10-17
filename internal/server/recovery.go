package server

import (
	"database/sql"
	"errors"
	"net/http"
	"time"
)

// Recovery links: someone who forgot their password gets back in through
// the person who invited them. The inviter's browser makes a one-time link
// the way it makes an invite: the secret stays in the URL fragment, the
// server keeps the SHA-256 of the auth key derived from it, plus the keys
// of the chats the two share, sealed with a key only the link can derive.
// Redeeming sets a new password and adds an active device that may ask
// chat partners for the keys of the other chats (the recovery flag).

const recoveryTTL = 24 * time.Hour

var errRecovery = errors.New("recovery")

func (s *Server) handleCreateRecovery(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		User   int64  `json:"user"`
		ID     []byte `json:"id"`
		Bundle []byte `json:"bundle"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.ID) != 32 || len(req.Bundle) == 0 || len(req.Bundle) > 1<<20 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	ctx := r.Context()
	expires := now() + recoveryTTL.Milliseconds()
	err := inTx(ctx, s.db, func(tx *sql.Tx) error {
		// Only the one who invited this person can vouch for them; anyone
		// else gets the same answer as for a user that does not exist.
		var by sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT invited_by FROM users WHERE id = ?`, req.User).Scan(&by); err != nil ||
			!by.Valid || by.Int64 != a.UserID {
			return errNotMember
		}
		// One live link per person: a new one replaces the old.
		if _, err := tx.ExecContext(ctx, `DELETE FROM recoveries WHERE user_id = ?`, req.User); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO recoveries (id, user_id, created_by, bundle, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?)`, req.ID, req.User, a.UserID, req.Bundle, now(), expires)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"expires_at": expires})
}

// handlePeekRecovery shows whose account the link restores and who made it.
func (s *Server) handlePeekRecovery(w http.ResponseWriter, r *http.Request) {
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
	var name, by string
	var bundle []byte
	var expires int64
	err := s.db.QueryRowContext(r.Context(), `SELECT u.name, c.name, k.bundle, k.expires_at FROM recoveries k
		JOIN users u ON u.id = k.user_id JOIN users c ON c.id = k.created_by
		WHERE k.id = ? AND k.expires_at > ?`, sha(req.Key), now()).Scan(&name, &by, &bundle, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "invite_invalid")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "by": by, "bundle": bundle, "expires_at": expires})
}

func (s *Server) handleRedeemRecovery(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key    []byte     `json:"key"`
		Device *devicePub `json:"device"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !s.auth.allow(s.clientIP(r)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	// A browser signed in to some account must not silently switch to
	// another: sign out first, or open the link on the device to restore.
	if me, err := s.session(r); err == nil && me != nil {
		fail(w, http.StatusConflict, "signed_in")
		return
	}
	if req.Device == nil || !req.Device.valid() {
		fail(w, http.StatusBadRequest, "bad_device")
		return
	}
	ctx := r.Context()
	// Hash outside the transaction: argon2 is slow and SQLite has one writer.
	password := newPassword()
	lookup, err := s.lookupKey(ctx, password)
	if err != nil {
		s.internal(w, err)
		return
	}
	id := sha(req.Key)
	var userID, creator, deviceID int64
	err = inTx(ctx, s.db, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT user_id, created_by FROM recoveries WHERE id = ? AND expires_at > ?`, id, now()).
			Scan(&userID, &creator)
		if errors.Is(err, sql.ErrNoRows) {
			return errRecovery
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recoveries WHERE id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET pass_lookup = ? WHERE id = ?`, lookup, userID); err != nil {
			return err // a lookup collision is ~2^-37; the link is spent, the inviter makes another
		}
		if deviceID, err = insertDevice(ctx, tx, userID, *req.Device, "active"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE devices SET recovery = 1 WHERE id = ?`, deviceID); err != nil {
			return err
		}
		// The bundle may predate a rotation: chats shared with the inviter
		// re-key at their next message, this device included.
		if _, err := tx.ExecContext(ctx, `UPDATE chats SET rotate = 1 WHERE id IN (
			SELECT m1.chat_id FROM members m1 JOIN members m2 ON m2.chat_id = m1.chat_id
			WHERE m1.user_id = ? AND m2.user_id = ?)`, userID, creator); err != nil {
			return err
		}
		return s.startSession(ctx, w, tx, deviceID)
	})
	if errors.Is(err, errRecovery) {
		fail(w, http.StatusNotFound, "invite_invalid")
		return
	}
	if s.writeErr(w, err) {
		return
	}
	// Partners now see the request for keys; the user's other devices hear
	// about the sign-in; people who verified the safety code re-check it.
	if ids, err := contactIDs(ctx, s.db, userID); err == nil {
		s.hub.toUsers(ids, event{"t": "device"})
		s.hub.toUsers(ids, event{"t": "peer", "u": userID})
	}
	s.push.notifyDevices(ctx, userID, deviceID, map[string]any{"t": "device", "label": req.Device.Label})
	writeJSON(w, http.StatusOK, map[string]any{"password": password, "device_id": deviceID, "user_id": userID})
}
