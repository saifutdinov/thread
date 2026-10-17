package server

import (
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
