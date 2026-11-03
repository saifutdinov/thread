package server

import (
	"bytes"
	"fmt"
	"testing"
)

type vaultView struct {
	Epoch   int    `json:"epoch"`
	Version int    `json:"version"`
	Body    []byte `json:"body"`
	Rotate  bool   `json:"rotate"`
	Lost    bool   `json:"lost"`
	Key     []byte `json:"key"`
	KeyFor  []struct {
		ID int64 `json:"id"`
	} `json:"key_for"`
	Missing []struct {
		ID     int64  `json:"id"`
		EncPub []byte `json:"enc_pub"`
		SigPub []byte `json:"sig_pub"`
	} `json:"missing"`
}

// The personal vault holds what only my devices may read (my names for
// people): a body sealed with a key of my own, wrapped for each of my
// devices, never for anyone else's.
func TestVault(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	keys := func(devices ...int64) []map[string]any {
		out := []map[string]any{}
		for _, d := range devices {
			out = append(out, map[string]any{"device": d, "wrapped": wrapped()})
		}
		return out
	}
	// put writes and returns the new version, or checks the error code.
	put := func(u *user, want int, code string, version, epoch int, body string, k []map[string]any) int {
		t.Helper()
		req := map[string]any{"version": version, "epoch": epoch, "body": []byte(body)}
		if k != nil {
			req["keys"] = k
		}
		var out struct {
			Version int    `json:"version"`
			Error   string `json:"error"`
		}
		u.must(want, "PUT", "/api/vault", req, &out)
		if out.Error != code {
			t.Fatalf("error %q, want %q", out.Error, code)
		}
		return out.Version
	}
	var v vaultView
	a.must(200, "GET", "/api/vault", nil, &v)
	if v.Epoch != 0 || v.Body != nil || len(v.KeyFor) != 1 || v.KeyFor[0].ID != a.id {
		t.Fatalf("empty vault: %+v", v)
	}

	// The first key goes to every active device of mine, or none.
	put(a, 409, "devices_changed", 0, 1, "b1", keys())
	put(a, 400, "bad_request", 0, 0, "b1", keys(a.id))
	if got := put(a, 200, "", 0, 1, "b1", keys(a.id)); got != 1 {
		t.Fatalf("version %d", got)
	}
	put(a, 409, "stale", 0, 1, "late", nil) // written on top of an older version
	if got := put(a, 200, "", 1, 1, "b2", nil); got != 2 {
		t.Fatalf("version %d", got)
	}

	// A second device, approved by the first (A has no chats, no chat
	// keys to hand over), holds no vault key yet: the first sees it
	// missing and hands it one; only a key holder may.
	a2 := e.newUser()
	var login struct {
		DeviceID int64 `json:"device_id"`
	}
	a2.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a2.dev.pub()}, &login)
	a2.id = login.DeviceID
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", a2.id), map[string]any{"keys": []any{}}, nil)
	a2.must(200, "GET", "/api/vault", nil, &v)
	if v.Key != nil || string(v.Body) != "b2" || v.Version != 2 || v.Lost {
		t.Fatalf("second device before its key: %+v", v)
	}
	a.must(200, "GET", "/api/vault", nil, &v)
	if len(v.Missing) != 1 || v.Missing[0].ID != a2.id || len(v.Missing[0].EncPub) == 0 || len(v.Missing[0].SigPub) == 0 {
		t.Fatalf("missing = %+v", v.Missing)
	}
	// Without the key it may neither write nor start a new one while A,
	// which holds it, is still there: that would wipe A's names.
	put(a2, 403, "forbidden", 2, 1, "wipe", nil)
	put(a2, 403, "forbidden", 2, 2, "wipe", keys(a.id, a2.id))
	a2.must(403, "POST", "/api/vault/keys", map[string]any{"epoch": 1, "keys": keys(a2.id)}, nil)
	w := wrapped()
	a.must(409, "POST", "/api/vault/keys", map[string]any{"epoch": 2, "keys": keys(a2.id)}, nil) // wrapped for another key
	a.must(200, "POST", "/api/vault/keys", map[string]any{"epoch": 1, "keys": []map[string]any{{"device": a2.id, "wrapped": w}}}, nil)
	a.must(200, "POST", "/api/vault/keys", map[string]any{"epoch": 1, "keys": keys(a2.id)}, nil) // again: the first wrap stays
	a2.must(200, "GET", "/api/vault", nil, &v)
	if !bytes.Equal(v.Key, w) {
		t.Fatal("the second device got no key")
	}
	a.must(200, "GET", "/api/vault", nil, &v)
	if len(v.Missing) != 0 {
		t.Fatalf("still missing %+v", v.Missing)
	}

	// Never for someone else's device; their vault is their own.
	b := e.register("B")
	a.must(400, "POST", "/api/vault/keys", map[string]any{"epoch": 1, "keys": keys(b.id)}, nil)
	b.must(404, "POST", "/api/vault/keys", map[string]any{"epoch": 1, "keys": keys(b.id)}, nil) // B has no vault
	put(a, 409, "devices_changed", 2, 2, "x", keys(a.id, a2.id, b.id))
	b.must(200, "GET", "/api/vault", nil, &v)
	if v.Epoch != 0 {
		t.Fatalf("B sees %+v", v)
	}

	// A device switched off knew the key: the next write takes a new one,
	// for those left of the ones that held it. A device I approved but
	// never gave my names (a4) is not among them.
	a4 := e.newUser()
	a4.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a4.dev.pub()}, &login)
	a4.id = login.DeviceID
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", a4.id), map[string]any{"keys": []any{}}, nil)
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/revoke", a2.id), nil, nil)
	a.must(200, "GET", "/api/vault", nil, &v)
	if !v.Rotate {
		t.Fatal("no rotation after a revoke")
	}
	put(a, 409, "rotate", 2, 1, "b3", nil)
	put(a, 409, "devices_changed", 2, 2, "b3", keys(a.id, a2.id))
	put(a, 409, "devices_changed", 2, 2, "b3", keys(a.id, a4.id))
	if got := put(a, 200, "", 2, 2, "b3", keys(a.id)); got != 3 {
		t.Fatalf("version %d", got)
	}
	a.must(200, "GET", "/api/vault", nil, &v)
	if v.Epoch != 2 || v.Rotate || string(v.Body) != "b3" || v.Key == nil {
		t.Fatalf("after rotation: %+v", v)
	}
	var old int
	if err := e.s.db.QueryRow(`SELECT COUNT(*) FROM vault_keys WHERE user_id = ? AND epoch < 2`, a.user).Scan(&old); err != nil || old != 0 {
		t.Fatalf("wraps of the old key left: %d %v", old, err)
	}
	a.must(400, "POST", "/api/vault/keys", map[string]any{"epoch": 2, "keys": keys(a2.id)}, nil) // switched off

	// Every device that held the key gone: the vault is lost, and a device
	// of mine without the key may start it again.
	a3 := e.newUser()
	a3.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": a3.dev.pub()}, &login)
	a3.id = login.DeviceID
	a.must(200, "POST", fmt.Sprintf("/api/devices/%d/approve", a3.id), map[string]any{"keys": []any{}}, nil)
	a3.must(200, "POST", fmt.Sprintf("/api/devices/%d/revoke", a.id), nil, nil)
	v = vaultView{}
	a3.must(200, "GET", "/api/vault", nil, &v)
	if !v.Lost || v.Key != nil {
		t.Fatalf("after losing every holder: %+v", v)
	}
	if got := put(a3, 200, "", 3, 3, "anew", keys(a3.id, a4.id)); got != 4 {
		t.Fatalf("version %d", got)
	}
}
