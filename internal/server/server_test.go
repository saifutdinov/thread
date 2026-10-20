package server

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"
)

// ---- harness ----

type env struct {
	t  *testing.T
	s  *Server
	ts *httptest.Server
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	s, err := New(context.Background(), Config{
		DataDir: dir, StaticDir: dir, BaseURL: "http://test", Pepper: make([]byte, 32), VAPIDSubject: "mailto:t@example.com",
	}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		ts.Close()
		s.Close()
	})
	return &env{t: t, s: s, ts: ts}
}

type user struct {
	t    *testing.T
	base string
	hc   *http.Client
	dev  device
	id   int64 // device id
	user int64
	pass string
}

func (e *env) newUser() *user {
	jar, _ := cookiejar.New(nil)
	return &user{t: e.t, base: e.ts.URL, hc: &http.Client{Jar: jar}, dev: newDevice(e.t)}
}

func (c *user) do(method, path string, body, out any, headers ...string) int {
	c.t.Helper()
	var r *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			c.t.Fatalf("%s %s: decode: %v", method, path, err)
		}
	}
	return resp.StatusCode
}

func (c *user) must(want int, method, path string, body, out any) {
	c.t.Helper()
	var raw json.RawMessage
	if got := c.do(method, path, body, &raw); got != want {
		c.t.Fatalf("%s %s: status %d, want %d: %s", method, path, got, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: decode: %v", method, path, err)
		}
	}
}

type device struct {
	enc *ecdh.PrivateKey
	sig *ecdsa.PrivateKey
}

func newDevice(t *testing.T) device {
	enc, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return device{enc, sig}
}

func (d device) pub() map[string]any {
	sigPub, _ := d.sig.PublicKey.Bytes()
	return map[string]any{"enc_pub": d.enc.PublicKey().Bytes(), "sig_pub": sigPub, "label": "test"}
}

// sign produces the raw r||s (IEEE P1363) form WebCrypto uses.
func (d device) sign(msg []byte) []byte {
	h := sha256.Sum256(msg)
	r, s, _ := ecdsa.Sign(rand.Reader, d.sig, h[:])
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out
}

// newInviteKey returns an auth key whose hash identifies an invite.
func newInviteKey(t *testing.T) []byte {
	auth, err := inviteAuthKey(randomBytes(32))
	if err != nil {
		t.Fatal(err)
	}
	return auth
}

// register creates a user through a registration invite inserted directly.
func (e *env) register(name string) *user {
	e.t.Helper()
	key := newInviteKey(e.t)
	if _, err := e.s.db.Exec(`INSERT INTO invites (id, max_uses, expires_at, created_at) VALUES (?, 1, ?, ?)`,
		sha(key), now()+3600e3, now()); err != nil {
		e.t.Fatal(err)
	}
	c := e.newUser()
	var out struct {
		Password string `json:"password"`
		DeviceID int64  `json:"device_id"`
	}
	c.must(200, "POST", "/api/invites/redeem", map[string]any{"key": key, "name": name, "device": c.dev.pub()}, &out)
	c.pass, c.id = out.Password, out.DeviceID
	var me Me
	c.must(200, "GET", "/api/me", nil, &me)
	c.user = me.User.ID
	return c
}

type Me struct {
	User struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	} `json:"user"`
	Device struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	} `json:"device"`
}

// join registers a new user through a chat invite.
func (e *env) join(key []byte, name string) *user {
	e.t.Helper()
	u := e.newUser()
	var out struct {
		Password string `json:"password"`
		DeviceID int64  `json:"device_id"`
	}
	u.must(200, "POST", "/api/invites/redeem", map[string]any{"key": key, "name": name, "device": u.dev.pub()}, &out)
	u.pass, u.id = out.Password, out.DeviceID
	var me Me
	u.must(200, "GET", "/api/me", nil, &me)
	u.user = me.User.ID
	return u
}

func wrapped() []byte { return randomBytes(wrappedSize) }

// createChat makes a chat whose first key is wrapped for all of c's active
// devices, plus an invite; it returns the chat id and the invite key.
func (c *user) createChat(kind string, maxUses int, devices ...int64) (int64, []byte) {
	c.t.Helper()
	if len(devices) == 0 {
		devices = []int64{c.id}
	}
	keys := []map[string]any{}
	for _, d := range devices {
		keys = append(keys, map[string]any{"device": d, "wrapped": wrapped()})
	}
	key := newInviteKey(c.t)
	var out struct {
		ChatID int64 `json:"chat_id"`
	}
	c.must(200, "POST", "/api/chats", map[string]any{
		"kind": kind, "keys": keys,
		"invite": map[string]any{"id": sha(key), "bundle": []byte("bundle"), "max_uses": maxUses},
	}, &out)
	return out.ChatID, key
}

// rotate installs the next epoch wrapped for exactly the given devices.
func (c *user) rotate(chat int64, epoch int, devices ...int64) int {
	keys := []map[string]any{}
	for _, d := range devices {
		keys = append(keys, map[string]any{"device": d, "wrapped": wrapped()})
	}
	return c.do("POST", fmt.Sprintf("/api/chats/%d/rotate", chat), map[string]any{"epoch": epoch, "keys": keys}, nil)
}

func (c *user) send(chat int64, epoch int, cid string) (int, message) {
	var m message
	var raw json.RawMessage
	code := c.do("POST", fmt.Sprintf("/api/chats/%d/messages", chat), map[string]any{
		"cid": cid, "epoch": epoch, "body": []byte("ciphertext"), "sig": randomBytes(64),
	}, &raw)
	if err := json.Unmarshal(raw, &m); err != nil {
		c.t.Fatal(err)
	}
	return code, m
}

// ---- unit ----

func TestNormalizePassword(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"DimondCrown_3213", "dimondcrown3213"},
		{"dimond crown 3213", "dimondcrown3213"},
		{"  DIMOND-CROWN.3213 ", "dimondcrown3213"},
		{"Дом_12", "12"},
		{"", ""},
	} {
		if got := normalizePassword(tc.in); got != tc.want {
			t.Errorf("normalizePassword(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNewPasswordFormat(t *testing.T) {
	re := regexp.MustCompile(`^[A-Z][a-z]+[A-Z][a-z]+_\d{4}$`)
	seen := map[string]bool{}
	for range 200 {
		p := newPassword()
		if !re.MatchString(p) {
			t.Fatalf("password %q does not match WordWord_1234", p)
		}
		seen[p] = true
	}
	if len(seen) < 199 {
		t.Fatalf("only %d distinct passwords out of 200", len(seen))
	}
	if len(words) < 3400 {
		t.Fatalf("word list too small: %d", len(words))
	}
}

func TestVerifySig(t *testing.T) {
	d := newDevice(t)
	pub, _ := d.sig.PublicKey.Bytes()
	msg := []byte("connect-login:nonce")
	sig := d.sign(msg)
	if !verifySig(pub, msg, sig) {
		t.Fatal("valid P1363 signature rejected")
	}
	bad := append([]byte{}, sig...)
	bad[10] ^= 1
	if verifySig(pub, msg, bad) || verifySig(pub, []byte("other"), sig) || verifySig(pub, msg, sig[:63]) {
		t.Fatal("invalid signature accepted")
	}
}

// The same vector is checked in web/src/lib/crypto.test.ts and was computed
// independently with Python's hmac: browser and server must agree.
func TestInviteAuthKeyVector(t *testing.T) {
	secret := make([]byte, 32)
	for i := range secret {
		secret[i] = byte(i + 1)
	}
	auth, err := inviteAuthKey(secret)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(auth); got != "cfa1c0ae7a5d292a57d42139a28db8cc02f918c61c66199f28e4b87f70fc0cdc" {
		t.Fatalf("auth = %s", got)
	}
	if got := hex.EncodeToString(sha(auth)); got != "751c296517665c5cb25bb8e4651e496b3f2c8f21205f9f7ff5d09a0319be4ac3" {
		t.Fatalf("id = %s", got)
	}
}

// ---- flows ----

func TestRegisterAndLogin(t *testing.T) {
	e := newEnv(t)
	a := e.register("  Anna   Maria ")

	var me Me
	a.must(200, "GET", "/api/me", nil, &me)
	if me.User.Name != "Anna Maria" || me.Device.Status != "active" {
		t.Fatalf("me = %+v", me)
	}

	// Known device: challenge signed by its key, password typed sloppily.
	b := e.newUser()
	b.dev = a.dev
	var ch struct {
		Nonce []byte `json:"nonce"`
	}
	b.must(200, "POST", "/api/auth/challenge", map[string]any{}, &ch)
	sloppy := normalizePassword(a.pass)[:len(normalizePassword(a.pass))-4] + " " + a.pass[len(a.pass)-4:]
	b.must(200, "POST", "/api/auth/login", map[string]any{
		"password": sloppy, "device_id": a.id, "nonce": ch.Nonce, "sig": a.dev.sign(append([]byte("connect-login:"), ch.Nonce...)),
	}, nil)

	// A nonce is single use.
	if code := b.do("POST", "/api/auth/login", map[string]any{
		"password": a.pass, "device_id": a.id, "nonce": ch.Nonce, "sig": a.dev.sign(append([]byte("connect-login:"), ch.Nonce...)),
	}, nil); code != 401 {
		t.Fatalf("replayed nonce: %d", code)
	}
	// Somebody else's key cannot sign in as this device.
	c := e.newUser()
	c.must(200, "POST", "/api/auth/challenge", map[string]any{}, &ch)
	if code := c.do("POST", "/api/auth/login", map[string]any{
		"password": a.pass, "device_id": a.id, "nonce": ch.Nonce, "sig": c.dev.sign(append([]byte("connect-login:"), ch.Nonce...)),
	}, nil); code != 401 {
		t.Fatalf("foreign signature: %d", code)
	}
	if code := c.do("POST", "/api/auth/login", map[string]any{"password": "WrongWrong_0000", "device": c.dev.pub()}, nil); code != 401 {
		t.Fatalf("wrong password: %d", code)
	}
}

func TestInviteIsSingleUse(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)

	b := e.newUser()
	b.must(200, "POST", "/api/invites/peek", map[string]any{"key": key}, nil)
	var out struct {
		ChatID int64 `json:"chat_id"`
	}
	b.must(200, "POST", "/api/invites/redeem", map[string]any{"key": key, "name": "B", "device": b.dev.pub()}, &out)
	if out.ChatID != chat {
		t.Fatalf("joined chat %d, want %d", out.ChatID, chat)
	}
	c := e.newUser()
	if code := c.do("POST", "/api/invites/peek", map[string]any{"key": key}, nil); code != 404 {
		t.Fatalf("used invite peek: %d", code)
	}
	if code := c.do("POST", "/api/invites/redeem", map[string]any{"key": key, "name": "C", "device": c.dev.pub()}, nil); code != 404 {
		t.Fatalf("used invite redeem: %d", code)
	}
	// A direct chat holds two people: no more invites into it.
	if code := a.do("POST", fmt.Sprintf("/api/chats/%d/invites", chat), map[string]any{
		"id": sha(newInviteKey(t)), "bundle": []byte("x"), "max_uses": 1,
	}, nil); code != 409 {
		t.Fatalf("invite into full direct chat: %d", code)
	}
}

func TestGroupInviteUses(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chatID, key := a.createChat("group", 2)
	for _, name := range []string{"B", "C"} {
		c := e.newUser()
		c.must(200, "POST", "/api/invites/redeem", map[string]any{"key": key, "name": name, "device": c.dev.pub()}, nil)
	}
	d := e.newUser()
	if code := d.do("POST", "/api/invites/redeem", map[string]any{"key": key, "name": "D", "device": d.dev.pub()}, nil); code != 404 {
		t.Fatalf("third use of a two-use invite: %d", code)
	}
	var chats []chat
	a.must(200, "GET", "/api/chats", nil, &chats)
	if len(chats) != 1 || chats[0].ID != chatID || len(chats[0].Members) != 3 {
		t.Fatalf("chats = %+v", chats)
	}
}

func TestPendingDeviceSeesNothingUntilApproved(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	a.send(chat, 1, "m1")

	// Same password, new browser.
	a2 := e.newUser()
	var login struct {
		DeviceID int64  `json:"device_id"`
		Status   string `json:"status"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	if login.Status != "pending" {
		t.Fatalf("new device status %q, want pending", login.Status)
	}
	for _, p := range []string{"/api/chats", "/api/keys", fmt.Sprintf("/api/chats/%d/messages", chat), "/api/sync?since=0", "/api/pending"} {
		if code := a2.do("GET", p, nil, nil); code != 403 {
			t.Errorf("pending device GET %s: %d, want 403", p, code)
		}
	}

	// The partner may not approve without a recovery request.
	if code := b.do("POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": []any{}}, nil); code != 403 {
		t.Fatalf("partner approve without recovery: %d", code)
	}

	// The owner sees it and hands over the key.
	var pend []map[string]any
	a.must(200, "GET", "/api/pending", nil, &pend)
	if len(pend) != 1 || pend[0]["own"] != true {
		t.Fatalf("pending = %v", pend)
	}
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{
		"keys": []map[string]any{{"chat": chat, "epoch": 1, "device": login.DeviceID, "wrapped": wrapped()}},
	}, nil)
	var keys []wrappedKey
	a2.must(200, "GET", "/api/keys", nil, &keys)
	if len(keys) != 1 || keys[0].Chat != chat {
		t.Fatalf("keys = %+v", keys)
	}
}

func TestPartnerRecovery(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")

	a2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	a2.must(200, "POST", "/api/devices/recovery", map[string]any{}, nil)

	var pend []map[string]any
	b.must(200, "GET", "/api/pending", nil, &pend)
	if len(pend) != 1 || pend[0]["own"] != false {
		t.Fatalf("partner pending = %v", pend)
	}
	// Only keys of shared chats: another chat of B's is refused.
	other, _ := b.createChat("group", 1)
	if code := b.do("POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{
		"keys": []map[string]any{{"chat": other, "epoch": 1, "device": login.DeviceID, "wrapped": wrapped()}},
	}, nil); code != 400 {
		t.Fatalf("partner wrapping a non-shared chat: %d", code)
	}
	b.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{
		"keys": []map[string]any{{"chat": chat, "epoch": 1, "device": login.DeviceID, "wrapped": wrapped()}},
	}, nil)
	a2.must(200, "GET", "/api/chats", nil, nil)
}

func TestMembershipIsChecked(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	_, m := a.send(chat, 1, "m1")
	var up struct {
		ID string `json:"id"`
	}
	req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/media?chat=%d", a.base, chat), bytes.NewReader([]byte("blob")))
	resp, err := a.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(resp.Body).Decode(&up); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	x := e.register("Outsider")
	for _, tc := range []struct{ method, path string }{
		{"GET", fmt.Sprintf("/api/chats/%d/messages", chat)},
		{"POST", fmt.Sprintf("/api/chats/%d/messages", chat)},
		{"GET", fmt.Sprintf("/api/chats/%d/devices", chat)},
		{"POST", fmt.Sprintf("/api/chats/%d/invites", chat)},
		{"DELETE", fmt.Sprintf("/api/chats/%d/messages", chat)},
		{"DELETE", fmt.Sprintf("/api/messages/%d", m.ID)},
		{"PUT", fmt.Sprintf("/api/messages/%d/reaction", m.ID)},
		{"GET", "/api/media/" + up.ID},
	} {
		body := map[string]any{"cid": "x", "epoch": 1, "body": []byte("c"), "sig": randomBytes(64), "id": sha(newInviteKey(t)), "bundle": []byte("b"), "max_uses": 1}
		if code := x.do(tc.method, tc.path, body, nil); code != 404 {
			t.Errorf("outsider %s %s: %d, want 404", tc.method, tc.path, code)
		}
	}
	var got []message
	x.must(200, "GET", "/api/sync?since=0", nil, &struct {
		Messages *[]message `json:"messages"`
	}{&got})
	if len(got) != 0 {
		t.Fatalf("outsider synced %d messages", len(got))
	}
}

func TestSendIsIdempotentAndSyncSeesChanges(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	_, m1 := a.send(chat, 1, "same")
	_, m2 := a.send(chat, 1, "same")
	if m1.ID == 0 || m1.ID != m2.ID {
		t.Fatalf("retry created a second message: %d vs %d", m1.ID, m2.ID)
	}
	var sync struct {
		Messages []message `json:"messages"`
		Seq      int64     `json:"seq"`
	}
	a.must(200, "GET", "/api/sync?since=0", nil, &sync)
	cursor := sync.Seq

	sync.Messages = nil
	a.must(200, "PATCH", fmt.Sprintf("/api/messages/%d", m1.ID), map[string]any{"epoch": 1, "body": []byte("edited"), "sig": randomBytes(64)}, nil)
	a.must(200, "PUT", fmt.Sprintf("/api/messages/%d/reaction", m1.ID), map[string]any{"epoch": 1, "body": []byte("r")}, nil)
	a.must(200, "GET", fmt.Sprintf("/api/sync?since=%d", cursor), nil, &sync)
	if len(sync.Messages) != 1 || string(sync.Messages[0].Body) != "edited" || len(sync.Messages[0].Reactions) != 1 {
		t.Fatalf("after edit+react: %+v", sync.Messages)
	}
	cursor = sync.Seq
	a.must(200, "DELETE", fmt.Sprintf("/api/messages/%d", m1.ID), nil, nil)
	sync.Messages = nil // json.Decode would merge into the old elements
	a.must(200, "GET", fmt.Sprintf("/api/sync?since=%d", cursor), nil, &sync)
	if len(sync.Messages) != 1 || !sync.Messages[0].Deleted || sync.Messages[0].Body != nil || sync.Messages[0].Reactions != nil {
		t.Fatalf("delete should leave an empty tombstone: %+v", sync.Messages)
	}
}

func TestDeleteAndClearRights(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	group, key := a.createChat("group", 2)
	b := e.join(key, "B")
	c := e.join(key, "C")

	// Joining forces a rotation that covers every member device.
	if code := b.rotate(group, 2, a.id, b.id, c.id); code != 200 {
		t.Fatalf("rotate after joins: %d", code)
	}
	_, mb := b.send(group, 2, "b1")
	if code := c.do("DELETE", fmt.Sprintf("/api/messages/%d", mb.ID), nil, nil); code != 403 {
		t.Fatalf("member deleting another's group message: %d", code)
	}
	if code := b.do("DELETE", fmt.Sprintf("/api/chats/%d/messages", group), nil, nil); code != 403 {
		t.Fatalf("non-creator clearing group history: %d", code)
	}
	a.must(200, "DELETE", fmt.Sprintf("/api/messages/%d", mb.ID), nil, nil)
	b.send(group, 2, "b2")
	a.must(200, "DELETE", fmt.Sprintf("/api/chats/%d/messages", group), nil, nil)
	var msgs []message
	b.must(200, "GET", fmt.Sprintf("/api/chats/%d/messages", group), nil, &msgs)
	if len(msgs) != 0 {
		t.Fatalf("history not cleared: %d messages", len(msgs))
	}

	// Direct chat: the partner may delete my message.
	direct, key2 := a.createChat("direct", 1)
	d := e.join(key2, "D")
	if code := a.rotate(direct, 2, a.id, d.id); code != 200 {
		t.Fatalf("rotate direct after join: %d", code)
	}
	_, ma := a.send(direct, 2, "a1")
	d.must(200, "DELETE", fmt.Sprintf("/api/messages/%d", ma.ID), nil, nil)
}

func TestLeaveForcesRotation(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("group", 2)
	b := e.join(key, "B")
	var bme Me
	b.must(200, "GET", "/api/me", nil, &bme)

	b.must(200, "DELETE", fmt.Sprintf("/api/chats/%d", chat), nil, nil)
	if code, _ := a.send(chat, 1, "after-leave"); code != 409 {
		t.Fatalf("send without rotation: %d, want 409", code)
	}
	// Wrapping for the departed member's device is refused.
	if code := a.do("POST", fmt.Sprintf("/api/chats/%d/rotate", chat), map[string]any{
		"epoch": 2,
		"keys": []map[string]any{
			{"device": a.id, "wrapped": wrapped()},
			{"device": bme.Device.ID, "wrapped": wrapped()},
		},
	}, nil); code != 409 {
		t.Fatalf("rotation including a former member: %d", code)
	}
	// Same count, wrong device: the key would go to the departed member.
	if code := a.do("POST", fmt.Sprintf("/api/chats/%d/rotate", chat), map[string]any{
		"epoch": 2, "keys": []map[string]any{{"device": bme.Device.ID, "wrapped": wrapped()}},
	}, nil); code != 409 {
		t.Fatalf("rotation wrapped for a former member only: %d", code)
	}
	if code := a.do("POST", fmt.Sprintf("/api/chats/%d/rotate", chat), map[string]any{
		"epoch": 3, "keys": []map[string]any{{"device": a.id, "wrapped": wrapped()}},
	}, nil); code != 409 {
		t.Fatalf("rotation skipping an epoch: %d", code)
	}
	a.must(200, "POST", fmt.Sprintf("/api/chats/%d/rotate", chat), map[string]any{
		"epoch": 2, "keys": []map[string]any{{"device": a.id, "wrapped": wrapped()}},
	}, nil)
	if code, _ := a.send(chat, 1, "old-epoch"); code != 409 {
		t.Fatalf("send with stale epoch: %d", code)
	}
	if code, _ := a.send(chat, 2, "new-epoch"); code != 200 {
		t.Fatalf("send with new epoch: %d", code)
	}
}

func TestRevokeDeviceForcesRotation(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	a2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": []any{}}, nil)
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/revoke", login.DeviceID), map[string]any{}, nil)
	if code := a2.do("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("revoked device still signed in: %d", code)
	}
	if code, _ := a.send(chat, 1, "x"); code != 409 {
		t.Fatalf("send after revoke without rotation: %d", code)
	}
}

func TestCrossOriginWriteRejected(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	if code := a.do("POST", "/api/chats", map[string]any{}, nil, "Origin", "https://evil.example"); code != 403 {
		t.Fatalf("cross-origin POST: %d", code)
	}
}

func TestLoginRateLimited(t *testing.T) {
	e := newEnv(t)
	c := e.newUser()
	limited := false
	for range 15 {
		if c.do("POST", "/api/auth/login", map[string]any{"password": "NopeNope_0000", "device": c.dev.pub()}, nil) == 429 {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("15 rapid bad logins were never rate limited")
	}
}

func TestExpiredInviteRejected(t *testing.T) {
	e := newEnv(t)
	key := newInviteKey(t)
	if _, err := e.s.db.Exec(`INSERT INTO invites (id, max_uses, expires_at, created_at) VALUES (?, 1, ?, ?)`,
		sha(key), time.Now().Add(-time.Minute).UnixMilli(), now()); err != nil {
		t.Fatal(err)
	}
	c := e.newUser()
	if code := c.do("POST", "/api/invites/redeem", map[string]any{"key": key, "name": "Late", "device": c.dev.pub()}, nil); code != 404 {
		t.Fatalf("expired invite: %d", code)
	}
}

// WebSockets hijack their connections, so the HTTP server does not wait for
// them: Close must stop their handlers before it closes the database.
func TestCloseStopsSockets(t *testing.T) {
	e := newEnv(t)
	e.register("A").socket(t)
	e.ts.Close()
	e.s.Close()
	if n := e.s.hub.count(); n != 0 {
		t.Fatalf("%d socket handlers outlived Close", n)
	}
}
