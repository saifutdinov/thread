package server

import "testing"

func TestRecoveryCanBeDisabledAndOldLinksStayRevoked(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	key := recoveryKey(t)
	link := map[string]any{"user": b.user, "id": sha(key), "bundle": []byte("sealed")}
	a.must(200, "POST", "/api/recoveries", link, nil)
	b.must(200, "PATCH", "/api/me", map[string]any{"recovery_allowed": false}, nil)
	var me struct {
		User struct {
			Allowed bool `json:"recovery_allowed"`
		} `json:"user"`
	}
	b.must(200, "GET", "/api/me", nil, &me)
	if me.User.Allowed {
		t.Fatal("recovery remains enabled")
	}
	a.must(404, "POST", "/api/recoveries", link, nil)
	fresh := e.newUser()
	fresh.must(404, "POST", "/api/recoveries/peek", map[string]any{"key": key}, nil)
	fresh.must(404, "POST", "/api/recoveries/redeem", map[string]any{"key": key, "device": fresh.dev.pub()}, nil)
	b.must(200, "PATCH", "/api/me", map[string]any{"recovery_allowed": true}, nil)
	fresh.must(404, "POST", "/api/recoveries/peek", map[string]any{"key": key}, nil)
	a.must(200, "POST", "/api/recoveries", link, nil)
	fresh.must(200, "POST", "/api/recoveries/peek", map[string]any{"key": key}, nil)
	pending := e.newUser()
	pending.must(200, "POST", "/api/auth/login", map[string]any{"password": b.pass, "device": pending.dev.pub()}, nil)
	pending.must(403, "PATCH", "/api/me", map[string]any{"recovery_allowed": false}, nil)
}

func TestInvalidProfilePatchDoesNotRevokeRecoveryLinks(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	_, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	key := recoveryKey(t)
	a.must(200, "POST", "/api/recoveries", map[string]any{"user": b.user, "id": sha(key), "bundle": []byte("sealed")}, nil)
	b.must(400, "PATCH", "/api/me", map[string]any{"name": "", "hide_online": true, "recovery_allowed": false}, nil)
	var me struct {
		User struct {
			Allowed bool   `json:"recovery_allowed"`
			Hidden  bool   `json:"hide_online"`
			Name    string `json:"name"`
		} `json:"user"`
	}
	b.must(200, "GET", "/api/me", nil, &me)
	if !me.User.Allowed || me.User.Hidden || me.User.Name != "B" {
		t.Fatalf("invalid patch changed profile: %+v", me.User)
	}
	e.newUser().must(200, "POST", "/api/recoveries/peek", map[string]any{"key": key}, nil)
}
