package server

import (
	"fmt"
	"testing"
)

// recoveryKey is the auth part of a recovery link: the browser derives it
// from the secret in the URL fragment; the server stores only its hash.
func recoveryKey(t *testing.T) []byte { return newInviteKey(t) }

func TestRecoveryLink(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B") // A invited B
	x := e.register("X")

	key := recoveryKey(t)
	link := map[string]any{"user": b.user, "id": sha(key), "bundle": []byte("sealed keys")}
	// Only the person who invited B may vouch for B.
	if code := x.do("POST", "/api/recoveries", link, nil); code != 404 {
		t.Fatalf("stranger made a recovery link: %d", code)
	}
	if code := b.do("POST", "/api/recoveries", map[string]any{"user": a.user, "id": sha(key), "bundle": []byte("k")}, nil); code != 404 {
		t.Fatalf("invitee made a link for the inviter: %d", code)
	}
	a.must(200, "POST", "/api/recoveries", link, nil)

	// Opening the link: who it restores and who made it, plus the bundle.
	var peek struct {
		Name   string `json:"name"`
		By     string `json:"by"`
		Bundle []byte `json:"bundle"`
	}
	fresh := e.newUser()
	fresh.must(200, "POST", "/api/recoveries/peek", map[string]any{"key": key}, &peek)
	if peek.Name != "B" || peek.By != "A" || string(peek.Bundle) != "sealed keys" {
		t.Fatalf("peek = %+v", peek)
	}
	if code := fresh.do("POST", "/api/recoveries/peek", map[string]any{"key": recoveryKey(t)}, nil); code != 404 {
		t.Fatalf("unknown key peeked: %d", code)
	}

	// Redeeming: a new password, an active device that may ask partners for
	// the keys of other chats, and a session.
	var got struct {
		Password string `json:"password"`
		DeviceID int64  `json:"device_id"`
	}
	fresh.must(200, "POST", "/api/recoveries/redeem", map[string]any{"key": key, "device": fresh.dev.pub()}, &got)
	if got.Password == "" || got.Password == b.pass {
		t.Fatalf("no new password: %q", got.Password)
	}
	var me Me
	fresh.must(200, "GET", "/api/me", nil, &me)
	if me.User.ID != b.user || me.Device.Status != "active" {
		t.Fatalf("me = %+v", me)
	}
	var recovery bool
	if err := e.s.db.QueryRow(`SELECT recovery FROM devices WHERE id = ?`, got.DeviceID).Scan(&recovery); err != nil || !recovery {
		t.Fatalf("device recovery flag = %v %v", recovery, err)
	}
	var rotate bool
	if err := e.s.db.QueryRow(`SELECT rotate FROM chats WHERE id = ?`, chat).Scan(&rotate); err != nil || !rotate {
		t.Fatalf("shared chat not flagged for rotation: %v %v", rotate, err)
	}

	// One use only.
	if code := e.newUser().do("POST", "/api/recoveries/redeem", map[string]any{"key": key, "device": e.newUser().dev.pub()}, nil); code != 404 {
		t.Fatalf("link reused: %d", code)
	}

	// The old password is gone, the new one works.
	other := e.newUser()
	if code := other.do("POST", "/api/auth/login", map[string]any{"password": b.pass, "device": other.dev.pub()}, nil); code == 200 {
		t.Fatal("old password still works")
	}
	other.must(200, "POST", "/api/auth/login", map[string]any{"password": got.Password, "device": other.dev.pub()}, nil)
}

func TestRecoveryLinkExpiresAndIsReplaced(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")

	first, second := recoveryKey(t), recoveryKey(t)
	a.must(200, "POST", "/api/recoveries", map[string]any{"user": b.user, "id": sha(first), "bundle": []byte("k")}, nil)
	a.must(200, "POST", "/api/recoveries", map[string]any{"user": b.user, "id": sha(second), "bundle": []byte("k")}, nil)
	u := e.newUser()
	if code := u.do("POST", "/api/recoveries/peek", map[string]any{"key": first}, nil); code != 404 {
		t.Fatalf("a replaced link still works: %d", code)
	}
	u.must(200, "POST", "/api/recoveries/peek", map[string]any{"key": second}, nil)

	if _, err := e.s.db.Exec(`UPDATE recoveries SET expires_at = ?`, now()-1); err != nil {
		t.Fatal(err)
	}
	if code := u.do("POST", "/api/recoveries/peek", map[string]any{"key": second}, nil); code != 404 {
		t.Fatalf("expired link still works: %d", code)
	}
}

func TestRecoveryLinkNeedsSignedOutDevice(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	key := recoveryKey(t)
	a.must(200, "POST", "/api/recoveries", map[string]any{"user": b.user, "id": sha(key), "bundle": []byte("k")}, nil)
	// A browser already signed in (here: as A) must not swap accounts.
	if code := a.do("POST", "/api/recoveries/redeem", map[string]any{"key": key, "device": a.dev.pub()}, nil); code != 409 {
		t.Fatalf("signed-in redeem: %d", code)
	}
}

func TestMembersShowWhoTheCallerInvited(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	var list []struct {
		Members []member `json:"members"`
	}
	a.must(200, "GET", "/api/chats", nil, &list)
	for _, m := range list[0].Members {
		if m.Invitee != (m.ID == b.user) {
			t.Fatalf("member %d invitee = %v", m.ID, m.Invitee)
		}
	}
	list = nil // json leaves omitted fields as they were
	b.must(200, "GET", "/api/chats", nil, &list)
	for _, m := range list[0].Members {
		if m.Invitee {
			t.Fatalf("B did not invite %d", m.ID)
		}
	}
}

// keyHolders lists the devices u's client must wrap the next key of chat for.
func keyHolders(u *user, chat int64) map[int64]bool {
	u.t.Helper()
	var list []struct {
		ID int64 `json:"id"`
	}
	u.must(200, "GET", fmt.Sprintf("/api/chats/%d/devices", chat), nil, &list)
	out := map[int64]bool{}
	for _, d := range list {
		out[d.ID] = true
	}
	return out
}

// The link lets the new device into the chats shared with the inviter
// only. Other partners decide for theirs, and the device cannot let itself
// (or a device it approves) in.
func TestRecoveryDeviceStaysOutOfOtherChats(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	ab, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	c := e.register("C")
	bc, inv2 := c.createChat("direct", 1)
	b.must(200, "POST", "/api/invites/redeem", map[string]any{"key": inv2}, nil)

	key := recoveryKey(t)
	a.must(200, "POST", "/api/recoveries", map[string]any{"user": b.user, "id": sha(key), "bundle": []byte("k")}, nil)
	fresh := e.newUser()
	var got struct {
		Password string  `json:"password"`
		DeviceID int64   `json:"device_id"`
		Chats    []int64 `json:"chats"`
	}
	// Keys smuggled in for a chat the inviter is not in are dropped.
	fresh.must(200, "POST", "/api/recoveries/redeem", map[string]any{"key": key, "device": fresh.dev.pub(), "keys": []map[string]any{
		{"chat": ab, "epoch": 1, "wrapped": wrapped()},
		{"chat": bc, "epoch": 1, "wrapped": wrapped()},
	}}, &got)
	if len(got.Chats) != 1 || got.Chats[0] != ab {
		t.Fatalf("stored chats = %v, want only %d", got.Chats, ab)
	}
	dev := got.DeviceID
	if !keyHolders(a, ab)[dev] {
		t.Fatal("not in the chat shared with the inviter")
	}
	if keyHolders(c, bc)[dev] {
		t.Fatal("in a chat nobody let it into")
	}
	if code := c.rotate(bc, 2, c.id, b.id, dev); code != 409 {
		t.Fatalf("rotation wrapped for it: %d", code)
	}
	c.must(200, "POST", fmt.Sprintf("/api/chats/%d/rotate", bc), map[string]any{"epoch": 2, "keys": []map[string]any{
		{"device": c.id, "wrapped": wrapped()}, {"device": b.id, "wrapped": wrapped()},
	}}, nil)

	// It cannot rotate the chat to a key of its own choosing.
	if code := fresh.rotate(bc, 3, c.id, b.id); code != 403 {
		t.Fatalf("rotation by a device left out: %d", code)
	}
	// A key of its own making does not let it in, nor plants one on B's
	// trusted device.
	for _, target := range []int64{dev, b.id} {
		if code := fresh.do("POST", "/api/keys", map[string]any{"keys": []map[string]any{
			{"chat": bc, "epoch": 2, "device": target, "wrapped": wrapped()},
		}}, nil); code != 403 {
			t.Fatalf("keys for a chat it is not in, for device %d: %d", target, code)
		}
	}
	if keyHolders(c, bc)[dev] {
		t.Fatal("let itself in")
	}
	// Nor does a device it approves: it stays a recovery device and gets no
	// keys the approver does not hold.
	other := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	other.must(200, "POST", "/api/auth/login", map[string]any{"password": got.Password, "device": other.dev.pub()}, &login)
	if code := fresh.do("POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": []map[string]any{
		{"chat": bc, "epoch": 2, "device": login.DeviceID, "wrapped": wrapped()},
	}}, nil); code != 403 {
		t.Fatalf("approval with keys it does not hold: %d", code)
	}
	fresh.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", login.DeviceID), map[string]any{"keys": []any{}}, nil)
	if keyHolders(c, bc)[login.DeviceID] {
		t.Fatal("a device it approved got in")
	}
	// Safety codes still count every device of the person.
	var all []struct {
		ID int64 `json:"id"`
	}
	c.must(200, "GET", fmt.Sprintf("/api/chats/%d/devices?all=1", bc), nil, &all)
	if len(all) != 4 { // C, B's old device, the recovered one and the one it approved
		t.Fatalf("all devices = %+v", all)
	}

	// C sees the request and answers it: from then on it is in.
	var pending []struct {
		ID int64 `json:"id"`
	}
	c.must(200, "GET", "/api/pending", nil, &pending)
	if len(pending) == 0 || pending[0].ID != dev {
		t.Fatalf("partner is not asked: %+v", pending)
	}
	c.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", dev), map[string]any{"keys": []map[string]any{
		{"chat": bc, "epoch": 2, "device": dev, "wrapped": wrapped()},
	}}, nil)
	if !keyHolders(c, bc)[dev] {
		t.Fatal("approved device left out")
	}
}

// A recovery device that joins a chat later takes part in it like any other.
func TestRecoveryDeviceJoinsNewChats(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	key := recoveryKey(t)
	a.must(200, "POST", "/api/recoveries", map[string]any{"user": b.user, "id": sha(key), "bundle": []byte("k")}, nil)
	fresh := e.newUser()
	var got struct {
		DeviceID int64 `json:"device_id"`
	}
	fresh.must(200, "POST", "/api/recoveries/redeem", map[string]any{"key": key, "device": fresh.dev.pub()}, &got)
	c := e.register("C")
	cb, inv2 := c.createChat("direct", 1)
	fresh.must(200, "POST", "/api/invites/redeem", map[string]any{"key": inv2}, nil)
	if !keyHolders(c, cb)[got.DeviceID] {
		t.Fatal("left out of a chat it joined itself")
	}
}

// A direct chat re-used for someone new remembers from which key on they
// are in, so their devices are not handed the earlier conversation.
func TestMembersShowTheirFirstEpoch(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	b.must(200, "DELETE", fmt.Sprintf("/api/chats/%d", chat), nil, nil)
	if code := a.rotate(chat, 2, a.id); code != 200 {
		t.Fatalf("rotate: %d", code)
	}
	key := newInviteKey(t)
	a.must(200, "POST", fmt.Sprintf("/api/chats/%d/invites", chat), map[string]any{"id": sha(key), "bundle": []byte("b"), "max_uses": 1}, nil)
	d := e.join(key, "D")
	var list []struct {
		Members []member `json:"members"`
	}
	a.must(200, "GET", "/api/chats", nil, &list)
	for _, m := range list[0].Members {
		if m.ID == d.user && m.Since != 2 {
			t.Fatalf("D since = %d, want 2", m.Since)
		}
	}
}
