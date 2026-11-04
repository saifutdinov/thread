package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
)

// Calls are 1:1 WebRTC. The server relays signaling between the two
// members of a direct chat and hands out short-lived TURN credentials; the
// signaling payload (SDP, ICE) is sealed with the chat key in the browser,
// so the server cannot swap the DTLS fingerprints and sit in the middle.
// Media never passes through this process.

const ringFor = 45 * time.Second

type callSignal struct {
	T    string `json:"t"`
	C    int64  `json:"c"`
	K    string `json:"k"`    // offer | answer | ice | reoffer | reanswer | restart | hangup | decline | busy
	ID   string `json:"id"`   // call id, chosen by the caller
	To   int64  `json:"to"`   // target device once known
	V    bool   `json:"v"`    // video offered
	E    int    `json:"e"`    // key epoch the body is sealed with
	Body []byte `json:"body"` // sealed SDP or ICE candidate
	H    bool   `json:"h"`    // "vis": the page went to the background
}

// callPeer returns the other member of a direct chat the caller is in.
func (s *Server) callPeer(ctx context.Context, chatID, userID int64) (int64, bool) {
	var kind string
	if err := s.db.QueryRowContext(ctx, `SELECT kind FROM chats WHERE id = ?`, chatID).Scan(&kind); err != nil || kind != "direct" {
		return 0, false
	}
	ids, err := chatUserIDs(ctx, s.db, chatID)
	if err != nil || len(ids) != 2 || !contains(ids, userID) {
		return 0, false
	}
	return without(ids, userID)[0], true
}

func (s *Server) activeDeviceOf(ctx context.Context, deviceID, userID int64) bool {
	var one int
	return s.db.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND status = 'active'`,
		deviceID, userID).Scan(&one) == nil
}

func (s *Server) handleCallSignal(ctx context.Context, c *client, in callSignal) {
	if !c.active || in.ID == "" || len(in.ID) > 64 || len(in.Body) > 48<<10 {
		return
	}
	peer, ok := s.callPeer(ctx, in.C, c.user)
	if !ok {
		return
	}
	ev, _ := json.Marshal(event{"t": "call", "k": in.K, "c": in.C, "id": in.ID, "from": c.user, "dev": c.device,
		"v": in.V, "e": in.E, "body": in.Body})
	toPeerDevice := func() {
		if in.To != 0 && s.activeDeviceOf(ctx, in.To, peer) {
			s.hub.sendDevice(in.To, ev)
		}
	}
	taken, _ := json.Marshal(event{"t": "call", "k": "taken", "c": in.C, "id": in.ID})
	stopRinging := func(user int64) { s.hub.sendUserExceptClient(user, c, taken) }
	key := callKey{chat: in.C, id: in.ID}
	switch in.K {
	case "offer":
		// Each offer wakes the callee's phones by push: a contact must not
		// be able to make them ring nonstop.
		if !s.auth.allow(fmt.Sprintf("call:%d", c.user)) {
			return
		}
		devices, err := queryIDs(ctx, s.db, `SELECT id FROM devices WHERE user_id = ? AND status = 'active'`, peer)
		if err != nil {
			return
		}
		status, replaced := s.ring.offer(c.user, c.device, peer, key, ev, devices, c.done)
		switch status {
		case 0:
			return
		case -1:
			s.hub.deliver(c, mustCallEvent(event{"t": "call", "k": "busy", "c": in.C, "id": in.ID, "from": peer}))
			return
		}
		if replaced != nil {
			// Retire the old id first, so a page still ringing accepts the
			// replacement instead of replying busy. The new push replaces
			// the old notification; an unscoped callEnd could erase it.
			s.hub.sendUsers([]int64{peer}, mustCallEvent(event{"t": "call", "k": "taken", "c": replaced.chat, "id": replaced.id}))
		}
		s.hub.sendUsers([]int64{peer}, ev)
		var name string
		if err := s.db.QueryRowContext(ctx, `SELECT name FROM users WHERE id = ?`, c.user).Scan(&name); err != nil {
			s.log.Warn("caller name", "err", err) // the push still rings, just without a name
		}
		s.push.notifyCall(ctx, in.C, peer, c.user, name, in.V, in.ID, false)
	case "answer":
		if !s.ring.answer(c.user, c.device, in.To, key, c.done) {
			s.hub.deliver(c, taken) // only this tab: never cancel the winning tab
			return
		}
		toPeerDevice()
		stopRinging(c.user)                             // the other devices of the one who picked up
		s.push.notifyCallEnd(ctx, c.user, false, in.ID) // and their ring notifications
	case "ice", "reoffer", "reanswer", "restart":
		// Mid-call: candidates, an ICE restart after a network change (the
		// caller re-offers; the callee may ask for it), device to device.
		if s.ring.relay(c.user, c.device, in.To, key, c.done) {
			toPeerDevice()
		}
	case "busy":
		if s.ring.busy(c.user, c.device, in.To, key, c.done, s.hub.callSockets(c.user)) {
			toPeerDevice()
			stopRinging(c.user)
			s.push.notifyCallEnd(ctx, c.user, false, in.ID)
		}
	case "hangup", "decline":
		to, ringingUser, ended := s.ring.end(c.user, c.device, peer, key, in.K, c.done)
		if !ended {
			// After a restart the browser still knows the selected device.
			// It checks the sender too; known calls keep the server's guard.
			if in.K == "hangup" && c.device != 0 && in.To != 0 && s.ring.relay(c.user, c.device, in.To, key, c.done) {
				toPeerDevice()
			}
			return
		}
		in.To = to
		if to != 0 {
			toPeerDevice()
		} else {
			s.hub.sendUsers([]int64{peer}, ev)
		}
		if ringingUser != 0 {
			stopRinging(ringingUser)
			s.push.notifyCallEnd(ctx, ringingUser, false, in.ID)
		}
	}
}

// handleCallDecline declines a ringing call from a notification's button:
// the service worker has no socket, and a phone may have no page open.
// Signed as device 0, so every page of the user stops ringing, this
// device's too. Only a call still ringing for this user counts: a stale
// notification's button must not end a call answered elsewhere.
func (s *Server) handleCallDecline(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		C  int64  `json:"c"`
		ID string `json:"id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.handleCallSignal(r.Context(), &client{user: a.UserID, active: true}, callSignal{T: "call", K: "decline", C: req.C, ID: req.ID})
	writeJSON(w, http.StatusOK, map[string]any{})
}

func mustCallEvent(e event) []byte {
	b, _ := json.Marshal(e) // event values here are JSON scalars
	return b
}

// handleTurn issues TURN REST credentials (coturn --use-auth-secret):
// username "<expiry>:<tag>", password HMAC-SHA1(secret, username). The tag
// is stable per user (for coturn's quotas) but opaque: plain TURN shows
// the username on the wire. Without TURN configured, calls still work
// where devices reach each other.
func (s *Server) handleTurn(w http.ResponseWriter, _ *http.Request, a *Auth) {
	servers := []any{}
	if s.cfg.TurnSecret != "" && len(s.cfg.TurnURLs) > 0 {
		// The relay answers STUN too: a plain binding request finds the
		// public address for a direct connection without a TURN allocation.
		stun := []string{}
		for _, u := range s.cfg.TurnURLs {
			host, _, _ := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(u, "turns:"), "turn:"), "?")
			if su := "stun:" + host; strings.HasPrefix(u, "turn:") && !slices.Contains(stun, su) {
				stun = append(stun, su)
			}
		}
		if len(stun) > 0 {
			servers = append(servers, map[string]any{"urls": stun})
		}
		tag := hmac.New(sha256.New, []byte(s.cfg.TurnSecret))
		_, _ = fmt.Fprintf(tag, "user:%d", a.UserID) // hash writes never fail
		user := fmt.Sprintf("%d:%x", time.Now().Add(12*time.Hour).Unix(), tag.Sum(nil)[:8])
		mac := hmac.New(sha1.New, []byte(s.cfg.TurnSecret))
		mac.Write([]byte(user))
		servers = append(servers, map[string]any{
			"urls": s.cfg.TurnURLs, "username": user, "credential": base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ice_servers": servers})
}
