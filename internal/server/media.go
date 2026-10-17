package server

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

// Media are opaque blobs: the browser encrypts each file with its own key,
// which travels inside the (encrypted) message. Files live on disk next to
// the database, not in it, so SQLite stays small and backups stay fast.

const maxUpload = 50 << 20

func (s *Server) mediaPath(id string) string { return filepath.Join(s.cfg.DataDir, "media", id) }

func validMediaID(id string) bool {
	b, err := hex.DecodeString(id)
	return err == nil && len(b) == 16
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request, a *Auth) {
	chatID, _ := strconv.ParseInt(r.URL.Query().Get("chat"), 10, 64)
	if !isMember(r.Context(), s.db, chatID, a.UserID) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	id := hex.EncodeToString(randomBytes(16))
	tmp, err := os.CreateTemp(filepath.Join(s.cfg.DataDir, "media"), ".upload-*")
	if err != nil {
		s.internal(w, err)
		return
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	size, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, maxUpload))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		fail(w, http.StatusRequestEntityTooLarge, "too_large")
		return
	}
	if err != nil || size == 0 {
		fail(w, http.StatusBadRequest, "bad_upload")
		return
	}
	if err := os.Rename(tmp.Name(), s.mediaPath(id)); err != nil {
		s.internal(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO media (id, chat_id, uploader, size, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, chatID, a.UserID, size, now()); err != nil {
		os.Remove(s.mediaPath(id))
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request, a *Auth) {
	id := r.PathValue("id")
	if !validMediaID(id) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	var chatID int64
	if err := s.db.QueryRowContext(r.Context(), `SELECT chat_id FROM media WHERE id = ?`, id).Scan(&chatID); err != nil ||
		!isMember(r.Context(), s.db, chatID, a.UserID) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	f, err := os.Open(s.mediaPath(id))
	if err != nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		s.internal(w, err)
		return
	}
	// Ciphertext never changes for an id, so the browser may keep it forever.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// handleCopyMedia makes a forwarded attachment readable in another chat:
// a new id pointing at the same ciphertext (a hard link, no extra space).
// The file key travels inside the forwarded, re-encrypted message.
func (s *Server) handleCopyMedia(w http.ResponseWriter, r *http.Request, a *Auth) {
	src := r.PathValue("id")
	var req struct {
		Chat int64 `json:"chat"`
	}
	if !validMediaID(src) || !readJSON(w, r, &req) {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	var from, size int64
	if err := s.db.QueryRowContext(r.Context(), `SELECT chat_id, size FROM media WHERE id = ?`, src).Scan(&from, &size); err != nil ||
		!isMember(r.Context(), s.db, from, a.UserID) || !isMember(r.Context(), s.db, req.Chat, a.UserID) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	id := hex.EncodeToString(randomBytes(16))
	if err := os.Link(s.mediaPath(src), s.mediaPath(id)); err != nil {
		s.internal(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO media (id, chat_id, uploader, size, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, req.Chat, a.UserID, size, now()); err != nil {
		os.Remove(s.mediaPath(id))
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) mediaIDs(ctx context.Context, q string, args ...any) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	return scanStrings(rows)
}

func txMediaIDs(ctx context.Context, tx *sql.Tx, q string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	return scanStrings(rows)
}

func scanStrings(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Server) deleteMedia(ctx context.Context, ids []string) error {
	for _, id := range ids {
		if err := os.Remove(s.mediaPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `DELETE FROM media WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}
