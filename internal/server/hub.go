package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"
)

// event is one server-to-browser WebSocket message; "t" names its type.
type event map[string]any

type client struct {
	user, device int64
	active       bool
	send         chan []byte
	cancel       context.CancelFunc
	hidden       bool // its page is in the background (computers keep the socket); guarded by hub.mu
}

// hub fans events out to connected devices and tracks presence.
// Limit: in-process only, one replica; needs a broker to scale out.
type hub struct {
	mu    sync.Mutex
	users map[int64]map[*client]struct{}
}

func newHub() *hub { return &hub{users: map[int64]map[*client]struct{}{}} }

// count is the number of open sockets, for metrics.
func (h *hub) count() (n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, cs := range h.users {
		n += len(cs)
	}
	return n
}

func (h *hub) add(c *client) (first bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.users[c.user]
	if set == nil {
		set = map[*client]struct{}{}
		h.users[c.user] = set
	}
	first = !h.activeIn(set)
	set[c] = struct{}{}
	return first && h.activeIn(set)
}

func (h *hub) remove(c *client) (last bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.users[c.user]
	was := h.activeIn(set)
	delete(set, c)
	if len(set) == 0 {
		delete(h.users, c.user)
	}
	return was && !h.activeIn(set)
}

// setHidden records a page going to the background or back; changed
// reports whether its user's presence flipped with it.
func (h *hub) setHidden(c *client, hidden bool) (changed bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.users[c.user]
	was := h.activeIn(set)
	c.hidden = hidden
	return was != h.activeIn(set)
}

// activeIn: someone is here, an approved device with its page in front.
func (h *hub) activeIn(set map[*client]struct{}) bool {
	for c := range set {
		if c.active && !c.hidden {
			return true
		}
	}
	return false
}

func (h *hub) online(user int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.activeIn(h.users[user])
}

func (h *hub) deviceOnline(device int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, set := range h.users {
		for c := range set {
			if c.device == device {
				return true
			}
		}
	}
	return false
}

// deviceInFront: an open socket whose page is visible. A background tab
// keeps its socket but still needs pushes for system notifications.
func (h *hub) deviceInFront(device int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, set := range h.users {
		for c := range set {
			if c.device == device && !c.hidden {
				return true
			}
		}
	}
	return false
}

// toUsers delivers to approved devices only: a pending device holds just a
// password, which must not reveal even message metadata.
func (h *hub) toUsers(ids []int64, e event) {
	b, _ := json.Marshal(e)
	h.sendUsers(ids, b)
}

func (h *hub) sendUsers(ids []int64, b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, id := range ids {
		for c := range h.users[id] {
			if c.active {
				h.deliver(c, b)
			}
		}
	}
}

// sendUserExcept reaches a user's approved devices other than one.
func (h *hub) sendUserExcept(user, except int64, b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[user] {
		if c.active && c.device != except {
			h.deliver(c, b)
		}
	}
}

func (h *hub) toDevice(device int64, e event) {
	b, _ := json.Marshal(e)
	h.sendDevice(device, b)
}

func (h *hub) sendDevice(device int64, b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, set := range h.users {
		for c := range set {
			if c.device == device {
				h.deliver(c, b)
			}
		}
	}
}

func (h *hub) closeDevice(device int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, set := range h.users {
		for c := range set {
			if c.device == device {
				c.cancel()
			}
		}
	}
}

// deliver never blocks: a client too slow to drain 256 events is dropped
// and resyncs on reconnect.
func (h *hub) deliver(c *client, b []byte) {
	select {
	case c.send <- b:
	default:
		c.cancel()
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request, a *Auth) {
	s.ws.Add(1) // before Accept hijacks the conn, so Shutdown still covers the Add
	defer s.ws.Done()
	conn, err := websocket.Accept(w, r, nil) // default: same-origin only
	if err != nil {
		return
	}
	conn.SetReadLimit(64 << 10) // call offers carry a sealed SDP
	ctx, cancel := context.WithCancel(s.wsCtx)
	defer cancel()
	c := &client{user: a.UserID, device: a.DeviceID, active: a.Status == "active", send: make(chan []byte, 256), cancel: cancel}
	if s.hub.add(c) {
		s.announce(ctx, a.UserID, true)
	}
	// A phone woken by the call push picks the ringing call up here.
	if ev := s.ring.get(a.UserID); ev != nil && c.active {
		c.send <- ev
	}
	defer func() {
		if s.hub.remove(c) {
			s.presenceChanged(context.Background(), a.UserID, false)
		}
		conn.CloseNow()
	}()

	s.ws.Go(func() { s.readWS(ctx, conn, c) })
	ping := time.NewTicker(25 * time.Second) // under nginx's 60s proxy_read_timeout
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-c.send:
			wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, b)
			wcancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		}
	}
}

// readWS handles the client-to-server events: "typing" and call signaling.
func (s *Server) readWS(ctx context.Context, conn *websocket.Conn, c *client) {
	defer c.cancel()
	var last time.Time
	signals := rate.NewLimiter(50, 200) // ICE candidates come in bursts
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var in callSignal
		if json.Unmarshal(b, &in) != nil {
			continue
		}
		if in.T == "vis" {
			if s.hub.setHidden(c, in.H) {
				s.presenceChanged(ctx, c.user, !in.H)
			}
			continue
		}
		if in.T == "call" {
			if signals.Allow() {
				s.handleCallSignal(ctx, c, in)
			}
			continue
		}
		if in.T != "typing" || !c.active || time.Since(last) < 2*time.Second {
			continue
		}
		last = time.Now()
		ids, err := chatUserIDs(ctx, s.db, in.C)
		if err != nil || !contains(ids, c.user) {
			continue
		}
		s.hub.toUsers(without(ids, c.user), event{"t": "typing", "c": in.C, "u": c.user})
	}
}

// presenceChanged: the user came online or left (closed the app, or put
// its last visible page in the background). Leaving stamps last_seen.
func (s *Server) presenceChanged(ctx context.Context, userID int64, online bool) {
	if !online {
		if _, err := s.db.ExecContext(ctx, `UPDATE users SET last_seen = ? WHERE id = ?`, now(), userID); err != nil {
			s.log.Warn("last seen", "err", err)
		}
	}
	s.announce(ctx, userID, online)
}

// announce tells contacts the user came online or left, unless hidden.
func (s *Server) announce(ctx context.Context, userID int64, online bool) {
	var hide bool
	var seen int64
	if err := s.db.QueryRowContext(ctx, `SELECT hide_online, last_seen FROM users WHERE id = ?`, userID).Scan(&hide, &seen); err != nil || hide {
		return
	}
	ids, err := contactIDs(ctx, s.db, userID)
	if err != nil {
		return
	}
	s.hub.toUsers(without(ids, userID), event{"t": "presence", "u": userID, "online": online, "last_seen": seen})
}

func contains(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

func without(ids []int64, id int64) []int64 {
	out := ids[:0:0]
	for _, v := range ids {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}
