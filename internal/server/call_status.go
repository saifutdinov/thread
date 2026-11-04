package server

import (
	"database/sql"
	"errors"
	"net/http"
	"time"
)

// A push may arrive after the call ended or was replaced. Notifications
// revalidate the exact id, never infer liveness from delivery order.
func (s *Server) handleCallStatus(w http.ResponseWriter, r *http.Request, a *Auth) {
	chat, ok := pathID(r)
	id := r.URL.Query().Get("call")
	if !ok || id == "" || len(id) > 64 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	kind, _, err := s.groupChat(r.Context(), chat, a.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	active := false
	if kind == "direct" {
		s.ring.mu.Lock()
		c, exists := s.ring.m[a.UserID]
		active = exists && c.chat == chat && c.id == id && time.Now().Before(c.until)
		s.ring.mu.Unlock()
	} else {
		s.groups.mu.Lock()
		if c := s.groups.byChat[chat]; c != nil && c.id == id && len(c.devices) > 0 {
			active = !contains(c.users(), a.UserID)
		}
		s.groups.mu.Unlock()
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]bool{"ringing": active})
}
