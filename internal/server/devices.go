package server

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request, a *Auth) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, label, status, created_at, last_seen FROM devices
		WHERE user_id = ? AND status <> 'revoked' ORDER BY id`, a.UserID)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, created, seen int64
		var label, status string
		if err := rows.Scan(&id, &label, &status, &created, &seen); err != nil {
			s.internal(w, err)
			return
		}
		out = append(out, map[string]any{"id": id, "label": label, "status": status, "created_at": created,
			"last_seen": seen, "online": s.hub.deviceOnline(id), "current": id == a.DeviceID})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDevicePubs serves public keys (?ids=1,2,3) for verifying message
// signatures and wrapping keys. Revoked devices are included: their old
// messages still need verifying.
func (s *Server) handleDevicePubs(w http.ResponseWriter, r *http.Request, a *Auth) {
	var ids []int64
	for _, p := range strings.Split(r.URL.Query().Get("ids"), ",") {
		if id, err := strconv.ParseInt(p, 10, 64); err == nil && len(ids) < 200 {
			ids = append(ids, id)
		}
	}
	out := []map[string]any{}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, out)
		return
	}
	in, args := placeholders(ids)
	// Only devices the caller can meet: own, of chat partners, or authors of
	// messages in the caller's chats (members who left still signed those).
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, user_id, enc_pub, sig_pub FROM devices WHERE id IN (`+in+`) AND (
		user_id = ?
		OR user_id IN (SELECT m2.user_id FROM members m1 JOIN members m2 ON m2.chat_id = m1.chat_id WHERE m1.user_id = ?)
		OR id IN (SELECT device_id FROM messages WHERE chat_id IN (SELECT chat_id FROM members WHERE user_id = ?)))`,
		append(args, a.UserID, a.UserID, a.UserID)...)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
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

// handlePending lists devices waiting for this user: their own new
// devices, and partners' devices that asked chat members for recovery.
func (s *Server) handlePending(w http.ResponseWriter, r *http.Request, a *Auth) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT d.id, d.user_id, u.name, d.label, d.enc_pub, d.sig_pub, d.created_at,
		d.user_id = ? AS own
		FROM devices d JOIN users u ON u.id = d.user_id
		WHERE (d.user_id = ? AND d.status = 'pending')
		   OR (d.user_id <> ? AND d.recovery = 1 AND d.status <> 'revoked' AND EXISTS (
		       SELECT 1 FROM members m1 JOIN members m2 ON m2.chat_id = m1.chat_id JOIN chats c ON c.id = m1.chat_id
		       WHERE m1.user_id = ? AND m2.user_id = d.user_id AND NOT EXISTS (
		           SELECT 1 FROM chat_keys k WHERE k.chat_id = c.id AND k.epoch = c.epoch AND k.device_id = d.id)))
		ORDER BY d.id`, a.UserID, a.UserID, a.UserID, a.UserID)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, user, created int64
		var name, label string
		var enc, sig []byte
		var own bool
		if err := rows.Scan(&id, &user, &name, &label, &enc, &sig, &created, &own); err != nil {
			s.internal(w, err)
			return
		}
		out = append(out, map[string]any{"id": id, "user": user, "name": name, "label": label, "enc_pub": enc,
			"sig_pub": sig, "created_at": created, "own": own})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleRecovery: a device that lost all its siblings asks chat partners
// to let it in.
func (s *Server) handleRecovery(w http.ResponseWriter, r *http.Request, a *Auth) {
	if _, err := s.db.ExecContext(r.Context(), `UPDATE devices SET recovery = 1 WHERE id = ?`, a.DeviceID); err != nil {
		s.internal(w, err)
		return
	}
	if ids, err := contactIDs(r.Context(), s.db, a.UserID); err == nil {
		s.hub.toUsers(ids, event{"t": "device"})
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleApprove activates a device by handing it chat keys. The caller's
// own pending device gets keys for any chat the caller is in (or none, when
// there are no chats yet). A partner can only answer a recovery request
// with real keys for chats both share: being a member somewhere else on
// the server is not enough to vouch for someone's device.
func (s *Server) handleApprove(w http.ResponseWriter, r *http.Request, a *Auth) {
	deviceID, _ := pathID(r)
	var req struct {
		Keys []wrappedKey `json:"keys"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	var owner int64
	err := inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		var status string
		var recovery, approverRecovery bool
		if err := tx.QueryRowContext(r.Context(), `SELECT recovery FROM devices WHERE id = ?`, a.DeviceID).Scan(&approverRecovery); err != nil {
			return err
		}
		if err := tx.QueryRowContext(r.Context(), `SELECT user_id, status, recovery FROM devices WHERE id = ?`, deviceID).
			Scan(&owner, &status, &recovery); err != nil {
			return err
		}
		own := owner == a.UserID
		if status == "revoked" || (!own && !recovery) || (own && status != "pending") {
			return errForbidden
		}
		if !own && len(req.Keys) == 0 {
			return errBadRequest
		}
		given := map[int64]int{} // chat -> newest epoch handed over
		current := map[int64]int{}
		for _, k := range req.Keys {
			var epoch int
			if err := tx.QueryRowContext(r.Context(), `SELECT epoch FROM chats WHERE id = ?`, k.Chat).Scan(&epoch); err != nil {
				return errBadRequest
			}
			current[k.Chat] = epoch
			given[k.Chat] = max(given[k.Chat], k.Epoch)
			if k.Device != deviceID || k.Epoch < 1 || k.Epoch > epoch || len(k.Wrapped) != wrappedSize ||
				!isMember(r.Context(), tx, k.Chat, a.UserID) || !isMember(r.Context(), tx, k.Chat, owner) {
				return errBadRequest
			}
			if _, err := tx.ExecContext(r.Context(), `INSERT OR IGNORE INTO chat_keys (chat_id, epoch, device_id, wrapped) VALUES (?, ?, ?, ?)`,
				k.Chat, k.Epoch, deviceID, k.Wrapped); err != nil {
				return err
			}
		}
		// A rotation that landed after the approver read the chat list left
		// this device out of the newest epoch: have the next writer rotate.
		for chat, e := range given {
			if e < current[chat] {
				if _, err := tx.ExecContext(r.Context(), `UPDATE chats SET rotate = 1 WHERE id = ?`, chat); err != nil {
					return err
				}
			}
		}
		// Approved by its owner: as trusted as the approving device. A
		// recovery device passes its limits on, or it could vouch for a
		// device that then joins every chat.
		if own {
			_, err := tx.ExecContext(r.Context(), `UPDATE devices SET status = 'active', recovery = ? WHERE id = ?`, approverRecovery, deviceID)
			return err
		}
		_, err := tx.ExecContext(r.Context(), `UPDATE devices SET status = 'active' WHERE id = ?`, deviceID)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	s.hub.toDevice(deviceID, event{"t": "approved"})
	s.hub.toUsers([]int64{a.UserID, owner}, event{"t": "device"})
	// People who verified the owner's security code re-check it now.
	if ids, err := contactIDs(r.Context(), s.db, owner); err == nil {
		s.hub.toUsers(without(ids, owner), event{"t": "peer", "u": owner})
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *Server) handleRevoke(w http.ResponseWriter, r *http.Request, a *Auth) {
	deviceID, _ := pathID(r)
	if err := s.revokeDevice(r.Context(), a.UserID, deviceID); s.writeErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// revokeDevice cuts a device off: sessions, keys and push go, and every
// chat the user is in must rotate so the device cannot read what follows.
func (s *Server) revokeDevice(ctx context.Context, userID, deviceID int64) error {
	var wasActive bool
	err := inTx(ctx, s.db, func(tx *sql.Tx) error {
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM devices WHERE id = ? AND user_id = ?`, deviceID, userID).Scan(&status); err != nil {
			return err
		}
		wasActive = status == "active"
		for _, q := range []string{
			`UPDATE devices SET status = 'revoked', recovery = 0 WHERE id = ?`,
			`DELETE FROM sessions WHERE device_id = ?`,
			`DELETE FROM chat_keys WHERE device_id = ?`,
			`DELETE FROM push_subs WHERE device_id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, q, deviceID); err != nil {
				return err
			}
		}
		if !wasActive {
			return nil
		}
		_, err := tx.ExecContext(ctx, `UPDATE chats SET rotate = 1 WHERE id IN (SELECT chat_id FROM members WHERE user_id = ?)`, userID)
		return err
	})
	if err != nil {
		return err
	}
	s.hub.closeDevice(deviceID)
	if wasActive {
		ids, err := contactIDs(ctx, s.db, userID)
		if err == nil {
			s.hub.toUsers(ids, event{"t": "chat"})
		}
	}
	s.hub.toUsers([]int64{userID}, event{"t": "device"})
	return nil
}
