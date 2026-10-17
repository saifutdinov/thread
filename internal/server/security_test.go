package server

import (
	"fmt"
	"testing"
)

// Regression tests for the independent review of the MVP.

func TestStrangerCannotAnswerRecovery(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	e.join(key, "B")
	x := e.register("Stranger")
	xChat, _ := x.createChat("group", 1)

	a2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	a2.must(200, "POST", "/api/devices/recovery", map[string]any{}, nil)

	approve := func(keys []map[string]any) int {
		return x.do("POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": keys}, nil)
	}
	if code := approve(nil); code != 400 {
		t.Fatalf("stranger approving with no keys: %d", code)
	}
	if code := approve([]map[string]any{{"chat": xChat, "epoch": 1, "device": login.DeviceID, "wrapped": wrapped()}}); code != 400 {
		t.Fatalf("stranger approving with own chat key: %d", code)
	}
	if code := approve([]map[string]any{{"chat": chat, "epoch": 1, "device": login.DeviceID, "wrapped": wrapped()}}); code != 400 {
		t.Fatalf("stranger approving with a foreign chat id: %d", code)
	}
	if code := a2.do("GET", "/api/chats", nil, nil); code != 403 {
		t.Fatalf("device must still be pending: %d", code)
	}
}

func TestPasswordAloneNeedsApproval(t *testing.T) {
	e := newEnv(t)
	a := e.register("A") // no chats yet, one working device

	a2 := e.newUser()
	var login struct {
		DeviceID int64  `json:"device_id"`
		Status   string `json:"status"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	if login.Status != "pending" {
		t.Fatalf("password alone activated a device next to a working one: %s", login.Status)
	}
	// The owner approves even without chats (nothing to wrap).
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": []any{}}, nil)

	// Nothing to protect and nobody to approve: straight in.
	lone := e.register("Lone")
	lone.must(200, "POST", "/api/auth/logout", map[string]any{}, nil)
	l2 := e.newUser()
	l2.must(200, "POST", "/api/auth/login", map[string]any{"password": lone.pass, "device": l2.dev.pub()}, &login)
	if login.Status != "active" {
		t.Fatalf("user with no chats and no devices: %s", login.Status)
	}
}

func TestJoinForcesRotation(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("group", 3)
	b := e.join(key, "B")
	if code, _ := a.send(chat, 1, "x"); code != 409 {
		t.Fatalf("send right after a join: %d, want 409 rotate", code)
	}
	if code := a.rotate(chat, 2, a.id); code != 409 {
		t.Fatalf("rotation leaving out the newcomer: %d", code)
	}
	if code := a.rotate(chat, 2, a.id, b.id); code != 200 {
		t.Fatalf("rotation with the newcomer: %d", code)
	}
	if code, _ := b.send(chat, 2, "hi"); code != 200 {
		t.Fatalf("newcomer writing in the new epoch: %d", code)
	}
}

func TestApprovalMissingNewestEpochFlagsRotation(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	a.rotate(chat, 2, a.id, b.id)

	a2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	// The approver only had epoch 1 when it read the chat list.
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{
		"keys": []map[string]any{{"chat": chat, "epoch": 1, "device": login.DeviceID, "wrapped": wrapped()}},
	}, nil)
	if code, _ := b.send(chat, 2, "x"); code != 409 {
		t.Fatalf("chat should require a rotation that includes the new device: %d", code)
	}
}

func TestDevicePubsAreScoped(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	x := e.register("X")
	var got []map[string]any
	x.must(200, "GET", fmt.Sprintf("/api/devices/pub?ids=%d,%d", a.id, b.id), nil, &got)
	if len(got) != 0 {
		t.Fatalf("stranger fetched %d device keys", len(got))
	}
	b.must(200, "GET", fmt.Sprintf("/api/devices/pub?ids=%d", a.id), nil, &got)
	if len(got) != 1 {
		t.Fatalf("partner got %d device keys, want 1", len(got))
	}
}

func TestKnownDeviceLoginIsNoPasswordOracle(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	x := e.newUser()
	// Without the device key the answer is the same for right and wrong passwords.
	for _, pw := range []string{a.pass, "WrongWrong_0000"} {
		var ch struct {
			Nonce []byte `json:"nonce"`
		}
		x.must(200, "POST", "/api/auth/challenge", map[string]any{}, &ch)
		var out map[string]string
		x.do("POST", "/api/auth/login", map[string]any{
			"password": pw, "device_id": a.id, "nonce": ch.Nonce, "sig": x.dev.sign(append([]byte("connect-login:"), ch.Nonce...)),
		}, &out)
		if out["error"] != "bad_signature" {
			t.Fatalf("password %q: got %q, want bad_signature", pw, out["error"])
		}
	}
}

func TestChangePassword(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	if code := a.do("POST", "/api/auth/password", map[string]any{"password": "WrongWrong_0000"}, nil); code != 401 {
		t.Fatalf("wrong current password: %d", code)
	}
	b := e.register("B")
	if code := a.do("POST", "/api/auth/password", map[string]any{"password": b.pass}, nil); code != 401 {
		t.Fatalf("someone else's password: %d", code)
	}
	var out struct {
		Password string `json:"password"`
	}
	a.must(200, "POST", "/api/auth/password", map[string]any{"password": a.pass}, &out)
	if out.Password == "" || out.Password == a.pass {
		t.Fatalf("new password = %q", out.Password)
	}
	c := e.newUser()
	if code := c.do("POST", "/api/auth/login", map[string]any{"password": a.pass, "device": c.dev.pub()}, nil); code != 401 {
		t.Fatalf("old password still works: %d", code)
	}
	c.must(200, "POST", "/api/auth/login", map[string]any{"password": out.Password, "device": c.dev.pub()}, nil)
	a.must(200, "GET", "/api/me", nil, nil) // the session that changed it stays
}

func TestOldChatKeyMustRotate(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	if code, _ := a.send(chat, 1, "fresh"); code != 200 {
		t.Fatalf("send with a fresh key: %d", code)
	}
	if _, err := e.s.db.Exec(`UPDATE chats SET epoch_at = ? WHERE id = ?`, now()-keyMaxAge.Milliseconds()-1000, chat); err != nil {
		t.Fatal(err)
	}
	if code, _ := a.send(chat, 1, "stale"); code != 409 {
		t.Fatalf("send with a week-old key: %d, want 409 rotate", code)
	}
	// The chat list says so, or the client would never rotate.
	var list []struct {
		Rotate bool `json:"rotate"`
	}
	a.must(200, "GET", "/api/chats", nil, &list)
	if !list[0].Rotate {
		t.Fatal("chat list does not ask to rotate a week-old key")
	}
	if code := a.rotate(chat, 2, a.id); code != 200 {
		t.Fatalf("rotate: %d", code)
	}
	if code, _ := a.send(chat, 2, "rotated"); code != 200 {
		t.Fatalf("send after rotation: %d", code)
	}
}

func TestChatDevicesCarrySigningKeys(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	var devs []map[string]any
	a.must(200, "GET", fmt.Sprintf("/api/chats/%d/devices", chat), nil, &devs)
	if len(devs) != 1 || devs[0]["sig_pub"] == nil || devs[0]["enc_pub"] == nil {
		t.Fatalf("devices = %v", devs)
	}
}
