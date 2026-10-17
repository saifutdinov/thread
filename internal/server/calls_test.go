package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// sock is a test WebSocket: a background reader forwards call events, so
// waiting for "nothing" never cancels a Read (which would close the conn).
type sock struct {
	conn *websocket.Conn
	ch   chan map[string]any
}

// socket opens the user's WebSocket with its session cookie.
func (c *user) socket(t *testing.T) *sock {
	t.Helper()
	u, _ := url.Parse(c.base)
	h := http.Header{}
	for _, ck := range c.hc.Jar.Cookies(u) {
		h.Add("Cookie", ck.Name+"="+ck.Value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.base, "http")+"/api/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	s := &sock{conn: conn, ch: make(chan map[string]any, 64)}
	go func() {
		defer close(s.ch)
		for {
			_, b, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var ev map[string]any
			if json.Unmarshal(b, &ev) == nil && ev["t"] == "call" {
				s.ch <- ev
			}
		}
	}()
	t.Cleanup(func() { conn.CloseNow() })
	return s
}

func emit(t *testing.T, s *sock, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := s.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

// expectCall waits for the next call event of the given kind; "" means
// none may arrive within the window.
func expectCall(t *testing.T, s *sock, kind string) map[string]any {
	t.Helper()
	select {
	case ev, ok := <-s.ch:
		if !ok {
			t.Fatalf("socket closed while waiting for %q", kind)
		}
		if kind == "" || ev["k"] != kind {
			t.Fatalf("unexpected call event %v (want %q)", ev, kind)
		}
		return ev
	case <-time.After(700 * time.Millisecond):
		if kind != "" {
			t.Fatalf("no %q call event", kind)
		}
		return nil
	}
}

func TestCallSignaling(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	x := e.register("X")

	wa, wb, wx := a.socket(t), b.socket(t), x.socket(t)
	offer := map[string]any{"t": "call", "k": "offer", "c": chat, "id": "call-1", "v": true, "e": 1, "body": []byte("sealed sdp")}

	emit(t, wx, offer) // an outsider cannot ring into someone else's chat
	expectCall(t, wb, "")

	emit(t, wa, offer)
	ev := expectCall(t, wb, "offer")
	if ev["from"] != float64(a.user) || ev["dev"] != float64(a.id) || ev["v"] != true {
		t.Fatalf("offer = %v", ev)
	}

	// A second phone of B that wakes up later still gets the ringing call.
	b2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	b2.must(200, "POST", "/api/auth/login", map[string]any{"password": b.pass, "device": b2.dev.pub()}, &login)
	b.must(200, "POST", "/api/devices/"+itoa(login.DeviceID)+"/approve", map[string]any{"keys": []any{}}, nil)
	w2 := b2.socket(t)
	expectCall(t, w2, "offer")

	// B answers from the first phone: only A's device hears it, the other
	// phone stops ringing, the outsider hears nothing.
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "call-1", "to": a.id, "e": 1, "body": []byte("sealed answer")})
	expectCall(t, wa, "answer")
	expectCall(t, w2, "taken")
	expectCall(t, wx, "")

	// Answered: a phone connecting now is not rung again.
	b3 := e.newUser()
	b3.must(200, "POST", "/api/auth/login", map[string]any{"password": b.pass, "device": b3.dev.pub()}, &login)
	b.must(200, "POST", "/api/devices/"+itoa(login.DeviceID)+"/approve", map[string]any{"keys": []any{}}, nil)
	expectCall(t, b3.socket(t), "")

	emit(t, wa, map[string]any{"t": "call", "k": "hangup", "c": chat, "id": "call-1", "to": b.id})
	expectCall(t, wb, "hangup")
}

func TestTurnCredentials(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	var none struct {
		Servers []any `json:"ice_servers"`
	}
	a.must(200, "GET", "/api/turn", nil, &none)
	if len(none.Servers) != 0 {
		t.Fatalf("TURN not configured but servers = %v", none.Servers)
	}

	e.s.cfg.TurnSecret = "s3cret"
	e.s.cfg.TurnURLs = []string{"turn:example.org:3478?transport=udp", "turn:example.org:3478?transport=tcp"}
	var out struct {
		Servers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"ice_servers"`
	}
	a.must(200, "GET", "/api/turn", nil, &out)
	// STUN on the same host comes first, without credentials: it finds the
	// public address for a direct connection, TURN is the fallback.
	if len(out.Servers) != 2 || len(out.Servers[0].URLs) != 1 || out.Servers[0].URLs[0] != "stun:example.org:3478" {
		t.Fatalf("stun entry = %+v", out.Servers)
	}
	out.Servers = out.Servers[1:]
	// "<expiry>:<opaque tag>": plain TURN shows the username on the wire.
	parts := strings.Split(out.Servers[0].Username, ":")
	if len(out.Servers) != 1 || len(parts) != 2 || len(parts[1]) != 16 || parts[1] == itoa(a.user) {
		t.Fatalf("servers = %+v", out.Servers)
	}
	mac := hmac.New(sha1.New, []byte("s3cret"))
	mac.Write([]byte(out.Servers[0].Username))
	if out.Servers[0].Credential != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatal("credential is not coturn's HMAC-SHA1 of the username")
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestCallFirstAnswerWins(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	b2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	b2.must(200, "POST", "/api/auth/login", map[string]any{"password": b.pass, "device": b2.dev.pub()}, &login)
	b.must(200, "POST", "/api/devices/"+itoa(login.DeviceID)+"/approve", map[string]any{"keys": []any{}}, nil)
	wa, wb, wb2 := a.socket(t), b.socket(t), b2.socket(t)

	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "c1", "e": 1, "body": []byte("o")})
	expectCall(t, wb, "offer")
	expectCall(t, wb2, "offer")

	answer := map[string]any{"t": "call", "k": "answer", "c": chat, "id": "c1", "to": a.id, "e": 1, "body": []byte("a")}
	emit(t, wb, answer)
	expectCall(t, wa, "answer")
	expectCall(t, wb2, "taken")
	emit(t, wb2, answer) // too late: bounced back, the caller never sees it
	expectCall(t, wb2, "taken")
	expectCall(t, wa, "")
}

func TestCallSignalingLimits(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	direct, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	group, gkey := a.createChat("group", 2)
	c := e.join(gkey, "C")
	x := e.register("X")
	wa, wb, wc, wx := a.socket(t), b.socket(t), c.socket(t), x.socket(t)

	// Groups have no calls; an answer cannot be steered to an outsider.
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": group, "id": "g", "e": 1, "body": []byte("o")})
	expectCall(t, wc, "")
	emit(t, wb, map[string]any{"t": "call", "k": "ice", "c": direct, "id": "c", "to": x.id, "e": 1, "body": []byte("i")})
	expectCall(t, wx, "")
	expectCall(t, wa, "")

	// Offer spam is cut off after a burst.
	got := 0
	for i := range 15 {
		emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": direct, "id": "spam" + itoa(int64(i)), "e": 1, "body": []byte("o")})
	}
	for {
		select {
		case <-wb.ch:
			got++
			continue
		case <-time.After(700 * time.Millisecond):
		}
		break
	}
	if got == 0 || got >= 15 {
		t.Fatalf("offers delivered = %d, want a capped burst", got)
	}
}

// After a network change the caller renegotiates ICE mid-call; those
// signals go only to the other side's device, like ICE candidates.
func TestCallRenegotiation(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	x := e.register("X")
	wa, wb, wx := a.socket(t), b.socket(t), x.socket(t)

	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "r1", "e": 1, "body": []byte("o")})
	expectCall(t, wb, "offer")
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "r1", "to": a.id, "e": 1, "body": []byte("a")})
	expectCall(t, wa, "answer")

	emit(t, wb, map[string]any{"t": "call", "k": "restart", "c": chat, "id": "r1", "to": a.id})
	expectCall(t, wa, "restart")
	emit(t, wa, map[string]any{"t": "call", "k": "reoffer", "c": chat, "id": "r1", "to": b.id, "e": 1, "body": []byte("o2")})
	if ev := expectCall(t, wb, "reoffer"); ev["dev"] != float64(a.id) {
		t.Fatalf("reoffer = %v", ev)
	}
	emit(t, wb, map[string]any{"t": "call", "k": "reanswer", "c": chat, "id": "r1", "to": a.id, "e": 1, "body": []byte("a2")})
	expectCall(t, wa, "reanswer")

	emit(t, wa, map[string]any{"t": "call", "k": "reoffer", "c": chat, "id": "r1", "to": x.id, "e": 1, "body": []byte("o3")})
	expectCall(t, wx, "")
	expectCall(t, wb, "")
}
