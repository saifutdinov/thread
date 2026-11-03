package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// Group calls go through a LiveKit SFU next to this server
// (docs/adr/0002-group-calls.md): every device sends its sound and picture
// once and the SFU forwards them to the others. Media is end-to-end
// encrypted frame by frame in the browser with a call key that only chat
// members can open (sealed with the chat key, like 1:1 signaling), so the
// SFU forwards ciphertext. This file hands out LiveKit tokens to members,
// keeps who is in which call, rings the chat and proxies LiveKit's
// signaling under /lk, so the browser needs no other host.

const (
	groupMax   = 10
	liveKitTTL = 10 * time.Minute // enough to connect; LiveKit refreshes it during the call
)

var callIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

type groupCall struct {
	id      string
	video   bool
	e       int             // chat key epoch the call key is sealed with
	key     []byte          // the call key, sealed with the chat key in the browser
	devices map[int64]int64 // device -> user: who is in the call now
}

// users lists who is in the call, each person once.
func (g *groupCall) users() []int64 {
	out := []int64{}
	for _, u := range g.devices {
		if !slices.Contains(out, u) {
			out = append(out, u)
		}
	}
	slices.Sort(out)
	return out
}

// groupCalls is the running calls by chat.
// ponytail: in memory, one replica; a restart forgets running calls, the apps in them put them back (rejoin) when their sockets return.
type groupCalls struct {
	mu     sync.Mutex
	byChat map[int64]*groupCall
	max    int
}

func newGroupCalls() *groupCalls { return &groupCalls{byChat: map[int64]*groupCall{}, max: groupMax} }

var (
	errCallFull    = errors.New("call_full")
	errBadCall     = errors.New("bad_call")
	errRateLimited = errors.New("rate_limited")
)

// join puts the device into the chat's call, starting it from want when
// none runs (if mayStart allows). It returns a copy of the call and
// whether it was started now. Under one lock: of two who start at once,
// one starts and the other joins that call, with its key.
func (g *groupCalls) join(chat, user, device int64, want groupCall, mayStart func() bool) (groupCall, bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	c, ok := g.byChat[chat]
	started := !ok
	if started {
		if !callIDRe.MatchString(want.id) || want.e < 1 || len(want.key) == 0 || len(want.key) > 1024 {
			return groupCall{}, false, errBadCall
		}
		if !mayStart() {
			return groupCall{}, false, errRateLimited
		}
		c = &groupCall{id: want.id, video: want.video, e: want.e, key: want.key, devices: map[int64]int64{}}
		g.byChat[chat] = c
	}
	if _, in := c.devices[device]; !in && len(c.devices) >= g.max {
		return groupCall{}, false, errCallFull
	}
	c.devices[device] = user
	return c.snapshot(), started, nil
}

// leave takes the device out of the chat's call (chat 0: out of every
// call it is in) and returns the calls that changed; an empty one is over.
func (g *groupCalls) leave(chat, device int64) map[int64]groupCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := map[int64]groupCall{}
	for id, c := range g.byChat {
		if _, in := c.devices[device]; !in || (chat != 0 && id != chat) {
			continue
		}
		delete(c.devices, device)
		out[id] = c.snapshot()
		if len(c.devices) == 0 {
			delete(g.byChat, id)
		}
	}
	return out
}

// leaveUser takes all of a user's devices out of the chat's call.
func (g *groupCalls) leaveUser(chat, user int64) map[int64]groupCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := map[int64]groupCall{}
	c, ok := g.byChat[chat]
	if !ok {
		return out
	}
	for d, u := range c.devices {
		if u == user {
			delete(c.devices, d)
			out[chat] = groupCall{}
		}
	}
	if _, changed := out[chat]; changed {
		out[chat] = c.snapshot()
		if len(c.devices) == 0 {
			delete(g.byChat, chat)
		}
	}
	return out
}

// running: the chats with a call going on, and the calls' ids.
func (g *groupCalls) running() map[int64]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[int64]string, len(g.byChat))
	for chat, c := range g.byChat {
		out[chat] = c.id
	}
	return out
}

func (g *groupCalls) get(chat int64) (groupCall, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	c, ok := g.byChat[chat]
	if !ok {
		return groupCall{}, false
	}
	return c.snapshot(), true
}

func (c *groupCall) snapshot() groupCall {
	cp := *c
	cp.devices = make(map[int64]int64, len(c.devices))
	for d, u := range c.devices {
		cp.devices[d] = u
	}
	return cp
}

func (s *Server) groupCallsOn() bool {
	return s.cfg.LiveKitURL != "" && s.cfg.LiveKitKey != "" && s.cfg.LiveKitSecret != ""
}

// groupChat returns the chat's kind and members; sql.ErrNoRows when it
// does not exist or the user is not in it.
func (s *Server) groupChat(ctx context.Context, chat, user int64) (kind string, members []int64, err error) {
	if err := s.db.QueryRowContext(ctx, `SELECT kind FROM chats WHERE id = ?`, chat).Scan(&kind); err != nil {
		return "", nil, err
	}
	ids, err := chatUserIDs(ctx, s.db, chat)
	if err != nil {
		return "", nil, err
	}
	if !contains(ids, user) {
		return "", nil, sql.ErrNoRows
	}
	return kind, ids, nil
}

// handleGroupCall starts the chat's call or joins the running one and
// returns a LiveKit token. The sealed key in the body is used only by the
// one who starts it; everyone else gets the running call's. "rejoin" puts
// back a call this server forgot (a restart) without ringing anyone.
func (s *Server) handleGroupCall(w http.ResponseWriter, r *http.Request, a *Auth) {
	if !s.groupCallsOn() {
		fail(w, http.StatusNotFound, "group_calls_off")
		return
	}
	chat, ok := pathID(r)
	if !ok {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	kind, members, err := s.groupChat(r.Context(), chat, a.UserID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		fail(w, http.StatusNotFound, "not_found")
		return
	case err != nil:
		s.internal(w, err)
		return
	case kind != "group":
		fail(w, http.StatusBadRequest, "not_group")
		return
	}
	var req struct {
		ID     string `json:"id"`
		V      bool   `json:"v"`
		E      int    `json:"e"`
		Key    []byte `json:"key"`
		Rejoin bool   `json:"rejoin"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		fail(w, http.StatusBadRequest, "bad_json")
		return
	}
	// Starting rings every member's phones: a member must not be able to make them ring nonstop.
	mayStart := func() bool { return req.Rejoin || s.auth.allow(fmt.Sprintf("call:%d", a.UserID)) }
	c, started, err := s.groups.join(chat, a.UserID, a.DeviceID, groupCall{id: req.ID, video: req.V, e: req.E, key: req.Key}, mayStart)
	switch {
	case errors.Is(err, errCallFull):
		fail(w, http.StatusConflict, "call_full")
		return
	case errors.Is(err, errRateLimited):
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	case err != nil:
		fail(w, http.StatusBadRequest, "bad_call")
		return
	}
	// Who is in a call goes by the app's socket: without one, nothing
	// would ever take this device out. Checked after joining, so a socket
	// that closes meanwhile either sees the device in or is seen here.
	if !s.hub.deviceOnline(a.DeviceID) {
		s.groupCallsLeft(r.Context(), s.groups.leave(chat, a.DeviceID))
		fail(w, http.StatusConflict, "offline")
		return
	}
	if started && !req.Rejoin {
		s.hub.toUsers(without(members, a.UserID), event{"t": "gcall", "k": "ring", "c": chat, "id": c.id, "from": a.UserID, "v": c.video})
		var name string
		if err := s.db.QueryRowContext(r.Context(), `SELECT name FROM users WHERE id = ?`, a.UserID).Scan(&name); err != nil {
			s.log.Warn("caller name", "err", err) // the push still rings, just without a name
		}
		for _, m := range without(members, a.UserID) {
			s.push.notifyCall(r.Context(), chat, m, a.UserID, name, c.video, c.id, true)
		}
	} else if !started {
		s.push.notifyCallEnd(r.Context(), a.UserID, true) // picked up here: the ring on my sleeping devices goes
	}
	s.announceGroupCall(members, chat, c)
	// The room is the chat's own: a call id someone kept from another chat
	// leads nowhere. The identity ends in a random part per token, so two
	// tabs of one device do not throw each other out.
	writeJSON(w, http.StatusOK, map[string]any{
		"id": c.id, "url": "/lk", "e": c.e, "key": c.key, "v": c.video,
		"token": liveKitToken(s.cfg.LiveKitKey, s.cfg.LiveKitSecret, groupRoom(chat, c.id),
			fmt.Sprintf("%d.%d.%s", a.UserID, a.DeviceID, b64(randomBytes(4))), time.Now()),
	})
}

func groupRoom(chat int64, id string) string { return fmt.Sprintf("c%d-%s", chat, id) }

func (s *Server) handleLeaveGroupCall(w http.ResponseWriter, r *http.Request, a *Auth) {
	chat, ok := pathID(r)
	if !ok {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	s.groupCallsLeft(r.Context(), s.groups.leave(chat, a.DeviceID))
	writeJSON(w, http.StatusOK, map[string]any{})
}

// groupCallsLeft tells the chats whose calls a device left; a call that
// is over also takes its ring off sleeping phones.
func (s *Server) groupCallsLeft(ctx context.Context, changed map[int64]groupCall) {
	for chat, c := range changed {
		ids, err := chatUserIDs(ctx, s.db, chat)
		if err != nil {
			s.log.Warn("group call members", "chat", chat, "err", err)
			continue
		}
		s.announceGroupCall(ids, chat, c)
		if len(c.devices) == 0 {
			for _, u := range ids {
				s.push.notifyCallEnd(ctx, u, true)
			}
		}
	}
}

// announceGroupCall tells the chat who is in its call (nobody: it is over).
func (s *Server) announceGroupCall(members []int64, chat int64, c groupCall) {
	s.hub.toUsers(members, event{"t": "gcall", "k": "state", "c": chat, "id": c.id, "v": c.video, "users": c.users()})
}

// handleGroupCalls lists the running calls in the user's chats, for the
// "join" banners of an app that just opened.
func (s *Server) handleGroupCalls(w http.ResponseWriter, r *http.Request, a *Auth) {
	calls := []map[string]any{}
	if s.groupCallsOn() {
		chats, err := queryIDs(r.Context(), s.db, `SELECT chat_id FROM members WHERE user_id = ?`, a.UserID)
		if err != nil {
			s.internal(w, err)
			return
		}
		for _, chat := range chats {
			if c, ok := s.groups.get(chat); ok {
				calls = append(calls, map[string]any{"c": chat, "id": c.id, "v": c.video, "users": c.users()})
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"on": s.groupCallsOn(), "calls": calls})
}

// handleLiveKit proxies LiveKit's signaling (WebSocket and its HTTP
// checks) for signed-in devices; media goes to the SFU's own UDP and TCP
// ports. Our session cookie stays here: LiveKit has its own token.
func (s *Server) handleLiveKit(w http.ResponseWriter, r *http.Request, _ *Auth) {
	if !s.groupCallsOn() {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	target, err := url.Parse(s.cfg.LiveKitURL)
	if err != nil {
		s.internal(w, fmt.Errorf("LIVEKIT_URL: %w", err))
		return
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, "/lk")
		pr.Out.URL.RawPath = ""
		pr.Out.Header.Del("Cookie")
	}}
	proxy.ServeHTTP(w, r)
}

// liveKitToken is LiveKit's access token: a JWT (HS256) naming the room
// and what the participant may do in it.
func liveKitToken(key, secret, room, identity string, at time.Time) string {
	return liveKitJWT(key, secret, identity, at, map[string]any{"room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true})
}

// liveKitAdminToken may administer one room (list and remove people).
func liveKitAdminToken(key, secret, room string, at time.Time) string {
	return liveKitJWT(key, secret, "connect-server", at, map[string]any{"room": room, "roomAdmin": true})
}

func liveKitJWT(key, secret, sub string, at time.Time, video map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v) // plain maps of strings, numbers and bools
		return base64.RawURLEncoding.EncodeToString(b)
	}
	head := enc(map[string]string{"alg": "HS256", "typ": "JWT"})
	claims := enc(map[string]any{"iss": key, "sub": sub, "nbf": at.Unix() - 10, "exp": at.Add(liveKitTTL).Unix(), "video": video})
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(head + "." + claims))
	return head + "." + claims + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// roomService calls LiveKit's RoomService (Twirp, JSON) for one room.
func (s *Server) roomService(ctx context.Context, method, room string, body, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.LiveKitURL, "/")+"/twirp/livekit.RoomService/"+method, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+liveKitAdminToken(s.cfg.LiveKitKey, s.cfg.LiveKitSecret, room, time.Now()))
	resp, err := s.sfu.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("livekit %s: %s", method, resp.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// dropFromCall disconnects the LiveKit connections whose identity starts
// with prefix ("<user>." or "<user>.<device>.") from the chat's call:
// someone who left the group, or a device switched off. We stop giving
// them passes; this ends the connection they hold. Best effort, logged.
func (s *Server) dropFromCall(chat int64, id, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	room := groupRoom(chat, id)
	var list struct {
		Participants []struct {
			Identity string `json:"identity"`
		} `json:"participants"`
	}
	if err := s.roomService(ctx, "ListParticipants", room, map[string]string{"room": room}, &list); err != nil {
		s.log.Warn("group call: list people", "chat", chat, "err", err)
		return
	}
	for _, p := range list.Participants {
		if !strings.HasPrefix(p.Identity, prefix) {
			continue
		}
		if err := s.roomService(ctx, "RemoveParticipant", room, map[string]string{"room": room, "identity": p.Identity}, nil); err != nil {
			s.log.Warn("group call: remove", "chat", chat, "err", err)
		}
	}
}

// dropUser takes a user who left the chat out of its running call: out of
// who is in it here, and out of the room in LiveKit.
func (s *Server) dropUser(ctx context.Context, chat, user int64) {
	c, ok := s.groups.get(chat)
	if !ok {
		return
	}
	s.groupCallsLeft(ctx, s.groups.leaveUser(chat, user))
	go s.dropFromCall(chat, c.id, fmt.Sprintf("%d.", user))
}

// dropDevice takes a switched-off device out of every running call; it may
// hold a LiveKit connection in one its socket no longer shows.
func (s *Server) dropDevice(ctx context.Context, user, device int64) {
	s.groupCallsLeft(ctx, s.groups.leave(0, device))
	for chat, id := range s.groups.running() {
		go s.dropFromCall(chat, id, fmt.Sprintf("%d.%d.", user, device))
	}
}
