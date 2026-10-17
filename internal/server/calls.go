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
	"sync"
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
}

// ringing keeps the latest offer per callee for ringFor, so a phone that
// wakes up from the push notification still gets the call.
type ringing struct {
	mu sync.Mutex
	m  map[int64]pendingCall
}

type pendingCall struct {
	id    string
	ev    []byte
	until time.Time
}

func newRinging() *ringing { return &ringing{m: map[int64]pendingCall{}} }

// set reports whether this call was not ringing yet (a repeated offer
// for the same call does not ring the phone again).
func (r *ringing) set(user int64, id string, ev []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.m[user]
	r.m[user] = pendingCall{id: id, ev: ev, until: time.Now().Add(ringFor)}
	return !ok || p.id != id
}

// clear reports whether the call was still ringing: only the first of a
// user's devices to answer gets through.
func (r *ringing) clear(user int64, id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.m[user]; ok && p.id == id {
		delete(r.m, user)
		return true
	}
	return false
}

func (r *ringing) get(user int64) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.m[user]
	if !ok || time.Now().After(p.until) {
		delete(r.m, user)
		return nil
	}
	return p.ev
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
	stopRinging := func(user int64) { s.hub.sendUserExcept(user, c.device, taken) }
	switch in.K {
	case "offer":
		// Each offer wakes the callee's phones by push: a contact must not
		// be able to make them ring nonstop.
		if !s.auth.allow(fmt.Sprintf("call:%d", c.user)) || !s.ring.set(peer, in.ID, ev) {
			return
		}
		s.hub.sendUsers([]int64{peer}, ev)
		var name string
		if err := s.db.QueryRowContext(ctx, `SELECT name FROM users WHERE id = ?`, c.user).Scan(&name); err != nil {
			s.log.Warn("caller name", "err", err) // the push still rings, just without a name
		}
		s.push.notifyCall(ctx, in.C, peer, name, in.V)
	case "answer":
		if !s.ring.clear(c.user, in.ID) {
			s.hub.sendDevice(c.device, taken) // another device of mine was first
			return
		}
		toPeerDevice()
		stopRinging(c.user) // the other devices of the one who picked up
	case "ice", "reoffer", "reanswer", "restart":
		// Mid-call: candidates, an ICE restart after a network change (the
		// caller re-offers; the callee may ask for it), device to device.
		toPeerDevice()
	case "hangup", "decline", "busy":
		s.ring.clear(peer, in.ID)
		s.ring.clear(c.user, in.ID)
		if in.To != 0 {
			toPeerDevice()
		} else {
			s.hub.sendUsers([]int64{peer}, ev)
		}
		if in.K == "decline" {
			stopRinging(c.user)
		}
	}
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
