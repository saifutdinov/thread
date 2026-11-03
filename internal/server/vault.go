package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

// The personal vault: what only my own devices may read, my names for
// people (ADR 0001). The browser seals the body with a key of mine and
// wraps that key for my devices; the server keeps the body and the wraps
// and never the key. A wrap goes only to my own devices, and to a new one
// only by my hand. Writes name the version they replace, so two devices
// cannot overwrite each other unseen; a device switched off marks the key
// for a new one.

const maxVaultBody = 64 << 10

type vaultKey struct {
	Device  int64  `json:"device"`
	Wrapped []byte `json:"wrapped"`
}

// handleVault returns the sealed body, this device's wrap of the current
// key, and my active devices that have none yet. Only the person hands
// them one (POST /api/vault/keys), after checking the device's code:
// never on the server's word that a device is theirs.

// vaultHoldersSQL counts my active devices holding the key at an epoch.
const vaultHoldersSQL = `SELECT COUNT(*) FROM vault_keys k JOIN devices d ON d.id = k.device_id
	WHERE k.user_id = ? AND k.epoch = ? AND d.status = 'active'`

func (s *Server) handleVault(w http.ResponseWriter, r *http.Request, a *Auth) {
	ctx := r.Context()
	var epoch, version int
	var body []byte
	var rotate bool
	err := s.db.QueryRowContext(ctx, `SELECT epoch, version, body, rotate FROM vaults WHERE user_id = ?`, a.UserID).Scan(&epoch, &version, &body, &rotate)
	if errors.Is(err, sql.ErrNoRows) {
		out := map[string]any{"epoch": 0, "version": 0, "missing": []any{}}
		if s.addKeyFor(w, r, a, out, 0) {
			writeJSON(w, http.StatusOK, out)
		}
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	out := map[string]any{"epoch": epoch, "version": version, "body": body, "rotate": rotate}
	// Lost: no active device of mine holds the key any more (all of them
	// gone); then, and only then, a device without it may start anew.
	var held int
	if err := s.db.QueryRowContext(ctx, vaultHoldersSQL, a.UserID, epoch).Scan(&held); err != nil {
		s.internal(w, err)
		return
	}
	out["lost"] = held == 0
	var key []byte
	switch err := s.db.QueryRowContext(ctx, `SELECT wrapped FROM vault_keys WHERE user_id = ? AND epoch = ? AND device_id = ?`,
		a.UserID, epoch, a.DeviceID).Scan(&key); {
	case err == nil:
		out["key"] = key
	case !errors.Is(err, sql.ErrNoRows):
		s.internal(w, err)
		return
	}
	rows, err := s.db.QueryContext(ctx, `SELECT d.id, d.enc_pub, d.sig_pub FROM devices d WHERE d.user_id = ? AND d.status = 'active'
		AND NOT EXISTS (SELECT 1 FROM vault_keys k WHERE k.user_id = d.user_id AND k.epoch = ? AND k.device_id = d.id)`, a.UserID, epoch)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	missing := []map[string]any{}
	for rows.Next() {
		var id int64
		var enc, sig []byte
		if err := rows.Scan(&id, &enc, &sig); err != nil {
			s.internal(w, err)
			return
		}
		missing = append(missing, map[string]any{"id": id, "enc_pub": enc, "sig_pub": sig})
	}
	if err := rows.Err(); err != nil {
		s.internal(w, err)
		return
	}
	out["missing"] = missing
	if s.addKeyFor(w, r, a, out, epoch) {
		writeJSON(w, http.StatusOK, out)
	}
}

// addKeyFor adds who a new key would go to (vaultKeySet); false when it
// failed and the error is sent.
func (s *Server) addKeyFor(w http.ResponseWriter, r *http.Request, a *Auth, out map[string]any, epoch int) bool {
	set, err := vaultKeySet(r.Context(), s.db, a.UserID, a.DeviceID, epoch)
	if err != nil {
		s.internal(w, err)
		return false
	}
	keyFor := []map[string]any{}
	for id, pub := range set {
		keyFor = append(keyFor, map[string]any{"id": id, "enc_pub": pub})
	}
	out["key_for"] = keyFor
	return true
}

// handlePutVault replaces the body. With keys it starts the next key epoch,
// wrapped for exactly vaultKeySet (the first key, after a device was
// switched off, or once nobody holds it); without, it writes under the
// current key, which only a device holding it may.
func (s *Server) handlePutVault(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Version int        `json:"version"`
		Epoch   int        `json:"epoch"`
		Body    []byte     `json:"body"`
		Keys    []vaultKey `json:"keys"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Body) == 0 || len(req.Body) > maxVaultBody || req.Epoch < 1 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	ctx := r.Context()
	var next int
	err := inTx(ctx, s.db, func(tx *sql.Tx) error {
		var epoch, version int
		var rotate bool
		err := tx.QueryRowContext(ctx, `SELECT epoch, version, rotate FROM vaults WHERE user_id = ?`, a.UserID).Scan(&epoch, &version, &rotate)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if req.Version != version {
			return errStale
		}
		switch {
		case req.Keys != nil:
			if req.Epoch != epoch+1 {
				return errEpoch
			}
			// A new key from a device without the old one would drop the
			// names the holders have: only once nobody holds it.
			if epoch > 0 && !holdsVaultKey(ctx, tx, a.UserID, epoch, a.DeviceID) {
				var held int
				if err := tx.QueryRowContext(ctx, vaultHoldersSQL, a.UserID, epoch).Scan(&held); err != nil {
					return err
				}
				if held > 0 {
					return errForbidden
				}
			}
			if err := storeVaultKeys(ctx, tx, a.UserID, a.DeviceID, epoch, req.Epoch, req.Keys); err != nil {
				return err
			}
			// The old key's wraps go: a server cannot serve that key again.
			if _, err := tx.ExecContext(ctx, `DELETE FROM vault_keys WHERE user_id = ? AND epoch < ?`, a.UserID, req.Epoch); err != nil {
				return err
			}
		case req.Epoch != epoch:
			return errEpoch
		case rotate:
			return errRotate
		case !holdsVaultKey(ctx, tx, a.UserID, epoch, a.DeviceID):
			return errForbidden
		}
		next = version + 1
		_, err = tx.ExecContext(ctx, `INSERT INTO vaults (user_id, epoch, version, body, rotate) VALUES (?, ?, ?, ?, 0)
			ON CONFLICT(user_id) DO UPDATE SET epoch = excluded.epoch, version = excluded.version, body = excluded.body, rotate = 0`,
			a.UserID, req.Epoch, next, req.Body)
		return err
	})
	if s.writeErr(w, err) {
		return
	}
	s.hub.toUsers([]int64{a.UserID}, event{"t": "vault"})
	writeJSON(w, http.StatusOK, map[string]any{"version": next})
}

// handleVaultKeys hands the current key to my devices that miss it, the
// person having checked each one's code; only a device holding the key
// may, and only to my own active devices. The wraps name their epoch: one
// made for a key replaced meanwhile would never open (409 epoch).
func (s *Server) handleVaultKeys(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Epoch int        `json:"epoch"`
		Keys  []vaultKey `json:"keys"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	ctx := r.Context()
	added := false
	err := inTx(ctx, s.db, func(tx *sql.Tx) error {
		var epoch int
		if err := tx.QueryRowContext(ctx, `SELECT epoch FROM vaults WHERE user_id = ?`, a.UserID).Scan(&epoch); err != nil {
			return err
		}
		if req.Epoch != epoch {
			return errEpoch
		}
		if !holdsVaultKey(ctx, tx, a.UserID, epoch, a.DeviceID) {
			return errForbidden
		}
		for _, k := range req.Keys {
			if !ownActiveDevice(ctx, tx, a.UserID, k.Device) || len(k.Wrapped) != wrappedSize {
				return errBadRequest
			}
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO vault_keys (user_id, epoch, device_id, wrapped) VALUES (?, ?, ?, ?)`,
				a.UserID, epoch, k.Device, k.Wrapped)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				added = true
			}
		}
		return nil
	})
	if s.writeErr(w, err) {
		return
	}
	if added {
		s.hub.toUsers([]int64{a.UserID}, event{"t": "vault"}) // the device that got it reads the vault now
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// vaultKeySet: the devices a new key goes to (id -> enc_pub). A rotation
// keeps the circle: those holding the current key, a device switched off
// being gone already. With nobody holding it (the first key, or every
// holder lost) my active devices, but not recovery ones: like a chat's
// key, the vault reaches those only by my hand. The writer always.
func vaultKeySet(ctx context.Context, q querier, user, device int64, epoch int) (map[int64][]byte, error) {
	var held int
	if err := q.QueryRowContext(ctx, vaultHoldersSQL, user, epoch).Scan(&held); err != nil {
		return nil, err
	}
	query := `SELECT id, enc_pub FROM devices WHERE user_id = ? AND status = 'active' AND (recovery = 0 OR id = ?)`
	args := []any{user, device}
	if held > 0 {
		query = `SELECT d.id, d.enc_pub FROM devices d WHERE d.user_id = ? AND d.status = 'active' AND (d.id = ? OR EXISTS
			(SELECT 1 FROM vault_keys k WHERE k.user_id = d.user_id AND k.epoch = ? AND k.device_id = d.id))`
		args = append(args, epoch)
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]byte{}
	for rows.Next() {
		var id int64
		var pub []byte
		if err := rows.Scan(&id, &pub); err != nil {
			return nil, err
		}
		out[id] = pub
	}
	return out, rows.Err()
}

// storeVaultKeys requires one wrap per device of vaultKeySet, no more.
func storeVaultKeys(ctx context.Context, tx *sql.Tx, user, device int64, old, epoch int, keys []vaultKey) error {
	set, err := vaultKeySet(ctx, tx, user, device, old)
	if err != nil {
		return err
	}
	seen := map[int64]bool{}
	for _, k := range keys {
		if seen[k.Device] || set[k.Device] == nil || len(k.Wrapped) != wrappedSize {
			return errDevices
		}
		seen[k.Device] = true
	}
	if len(seen) != len(set) {
		return errDevices
	}
	for _, k := range keys {
		if _, err := tx.ExecContext(ctx, `INSERT INTO vault_keys (user_id, epoch, device_id, wrapped) VALUES (?, ?, ?, ?)`,
			user, epoch, k.Device, k.Wrapped); err != nil {
			return err
		}
	}
	return nil
}

func holdsVaultKey(ctx context.Context, tx *sql.Tx, user int64, epoch int, device int64) bool {
	var one int
	return tx.QueryRowContext(ctx, `SELECT 1 FROM vault_keys WHERE user_id = ? AND epoch = ? AND device_id = ?`, user, epoch, device).Scan(&one) == nil
}

func ownActiveDevice(ctx context.Context, tx *sql.Tx, user, device int64) bool {
	var one int
	return tx.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND status = 'active'`, device, user).Scan(&one) == nil
}
