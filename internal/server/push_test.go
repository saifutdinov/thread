package server

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

type pushed struct {
	device  int64
	topic   string
	payload map[string]any
}

// pushes swaps the Web Push delivery for a recorder of the plain payloads.
func (e *env) pushes() chan pushed {
	ch := make(chan pushed, 64)
	e.s.push.post = func(s sub, body []byte, topic string, _ int) {
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		ch <- pushed{s.device, topic, m}
	}
	return ch
}

// drain collects what arrives within a short window.
func drain(ch chan pushed) []pushed {
	var out []pushed
	for {
		select {
		case p := <-ch:
			out = append(out, p)
		case <-time.After(300 * time.Millisecond):
			return out
		}
	}
}

func (c *user) subscribe(endpoint string) {
	c.t.Helper()
	c.must(200, "POST", "/api/push", map[string]any{"endpoint": endpoint, "keys": map[string]any{"p256dh": "k", "auth": "a"}}, nil)
}

// secondDevice signs the owner in on another device and approves it.
func (e *env) secondDevice(owner *user) *user {
	e.t.Helper()
	d := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	d.must(200, "POST", "/api/auth/login", map[string]any{"password": owner.pass, "device": d.dev.pub()}, &login)
	owner.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": []any{}}, nil)
	d.id, d.user, d.pass = login.DeviceID, owner.user, owner.pass
	return d
}

func kinds(ps []pushed, device int64) []string {
	var out []string
	for _, p := range ps {
		if p.device == device {
			out = append(out, fmt.Sprint(p.payload["t"]))
		}
	}
	return out
}

func TestQuietMessageIsNotPushed(t *testing.T) {
	e := newEnv(t)
	got := e.pushes()
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	b.subscribe("https://fcm.googleapis.com/fcm/send/b")
	a.rotate(chat, 2, a.id, b.id)

	send := func(quiet bool) {
		a.must(200, "POST", fmt.Sprintf("/api/chats/%d/messages", chat), map[string]any{
			"cid": fmt.Sprint(quiet), "epoch": 2, "body": []byte("x"), "sig": randomBytes(64), "quiet": quiet,
		}, nil)
	}
	send(true) // a finished call's log: nothing to tell
	if ps := drain(got); len(ps) != 0 {
		t.Fatalf("quiet message pushed: %+v", ps)
	}
	send(false)
	if k := kinds(drain(got), b.id); len(k) != 1 || k[0] != "msg" {
		t.Fatalf("pushes = %v", k)
	}
}

// A tab in the background keeps its socket (computers) and says so: it
// still needs the system notification.
func TestHiddenSocketStillGetsPush(t *testing.T) {
	e := newEnv(t)
	got := e.pushes()
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	b.subscribe("https://fcm.googleapis.com/fcm/send/b")
	a.rotate(chat, 2, a.id, b.id)
	ws := b.socket(t)
	msg := func(cid string) {
		a.must(200, "POST", fmt.Sprintf("/api/chats/%d/messages", chat), map[string]any{
			"cid": cid, "epoch": 2, "body": []byte("x"), "sig": randomBytes(64),
		}, nil)
	}
	msg("visible")
	if ps := drain(got); len(ps) != 0 {
		t.Fatalf("a page in front was pushed: %+v", ps)
	}
	emit(t, ws, map[string]any{"t": "vis", "h": true})
	time.Sleep(50 * time.Millisecond) // the socket's reader takes it in
	msg("hidden")
	if k := kinds(drain(got), b.id); len(k) != 1 || k[0] != "msg" {
		t.Fatalf("hidden tab pushes = %v", k)
	}
}

// Read on one device: the others drop that chat's notifications. Only
// devices that got one hear about it, and never through Apple or Mozilla,
// which drop subscriptions whose pushes show nothing.
func TestReadClearsNotificationsElsewhere(t *testing.T) {
	e := newEnv(t)
	got := e.pushes()
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	phone := e.secondDevice(b)
	mac := e.secondDevice(b)
	b.subscribe("https://fcm.googleapis.com/fcm/send/b")
	phone.subscribe("https://fcm.googleapis.com/fcm/send/phone")
	mac.subscribe("https://web.push.apple.com/mac")
	a.rotate(chat, 2, a.id, b.id, phone.id, mac.id)
	var m struct {
		ID int64 `json:"id"`
	}
	a.must(200, "POST", fmt.Sprintf("/api/chats/%d/messages", chat), map[string]any{
		"cid": "m1", "epoch": 2, "body": []byte("x"), "sig": randomBytes(64),
	}, &m)
	drain(got)

	b.socket(t) // the reading device is in front
	b.must(200, "POST", fmt.Sprintf("/api/chats/%d/read", chat), map[string]any{"id": m.ID}, nil)
	ps := drain(got)
	if k := kinds(ps, phone.id); len(k) != 1 || k[0] != "read" {
		t.Fatalf("phone pushes = %v", k)
	}
	if k := kinds(ps, mac.id); len(k) != 0 {
		t.Fatalf("an Apple subscription got a silent push: %v", k)
	}
	if k := kinds(ps, b.id); len(k) != 0 {
		t.Fatalf("the reader was pushed: %v", k)
	}
	b.must(200, "POST", fmt.Sprintf("/api/chats/%d/read", chat), map[string]any{"id": m.ID}, nil)
	if ps := drain(got); len(ps) != 0 {
		t.Fatalf("read twice, pushed twice: %+v", ps)
	}
}

// Answered on one device: the other devices' call notifications go.
func TestCallEndClearsOtherDevices(t *testing.T) {
	e := newEnv(t)
	got := e.pushes()
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	phone := e.secondDevice(b)
	phone.subscribe("https://fcm.googleapis.com/fcm/send/phone")
	wa, wb := a.socket(t), b.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "c1", "v": false, "e": 1, "body": []byte("sdp")})
	expectCall(t, wb, "offer")
	if k := kinds(drain(got), phone.id); len(k) != 1 || k[0] != "call" {
		t.Fatalf("ring pushes = %v", k)
	}
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "c1", "to": a.id, "e": 1, "body": []byte("sdp")})
	ps := drain(got)
	if k := kinds(ps, phone.id); len(k) != 1 || k[0] != "callEnd" {
		t.Fatalf("after the answer = %v", k)
	}
	if ps[0].topic != "call" {
		t.Fatalf("callEnd must replace a pending ring: topic %q", ps[0].topic)
	}
}

// The settings' check reaches this device even while it is in front.
func TestTestPushReachesThisDevice(t *testing.T) {
	e := newEnv(t)
	got := e.pushes()
	a := e.register("A")
	other := e.secondDevice(a)
	a.subscribe("https://fcm.googleapis.com/fcm/send/a")
	other.subscribe("https://fcm.googleapis.com/fcm/send/other")
	a.socket(t)
	var res struct {
		Sent int `json:"sent"`
	}
	a.must(200, "POST", "/api/push/test", map[string]any{}, &res)
	ps := drain(got)
	if res.Sent != 1 || len(ps) != 1 || ps[0].device != a.id || ps[0].payload["t"] != "test" {
		t.Fatalf("sent %d, pushes %+v", res.Sent, ps)
	}
	other.must(200, "DELETE", "/api/push", nil, nil)
	if code := other.do("POST", "/api/push/test", map[string]any{}, &res); code != 200 || res.Sent != 0 {
		t.Fatalf("no subscription: %d %d", code, res.Sent)
	}
}

// Presence follows the visible page: a tab left in the background keeps
// its socket but does not show its owner as online all day.
func TestHiddenTabIsNotOnline(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	online := func() bool {
		var chats []struct {
			Members []struct {
				ID     int64 `json:"id"`
				Online bool  `json:"online"`
			} `json:"members"`
		}
		a.must(200, "GET", "/api/chats", nil, &chats)
		for _, m := range chats[0].Members {
			if m.ID == b.user {
				return m.Online
			}
		}
		t.Fatal("B is not in the chat")
		return false
	}
	ws := b.socket(t)
	time.Sleep(50 * time.Millisecond)
	if !online() {
		t.Fatal("a visible page is online")
	}
	emit(t, ws, map[string]any{"t": "vis", "h": true})
	time.Sleep(50 * time.Millisecond)
	if online() {
		t.Fatal("a background tab shows its owner online")
	}
	emit(t, ws, map[string]any{"t": "vis", "h": false})
	time.Sleep(50 * time.Millisecond)
	if !online() {
		t.Fatal("back in front, still offline")
	}
}
