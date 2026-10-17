package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestAvatars(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("group", 1)
	b := e.join(key, "B")
	x := e.register("X")
	xChat, _ := x.createChat("group", 1)

	set := func(u *user, want int, body map[string]any) {
		t.Helper()
		if code := u.do("PUT", "/api/me/avatar", body, nil); code != want {
			t.Fatalf("set avatar %v = %d, want %d", body, code, want)
		}
	}
	item := func(c int64, epoch int, n int) map[string]any {
		return map[string]any{"chat": c, "epoch": epoch, "body": make([]byte, n)}
	}
	set(a, 400, map[string]any{"copy": true, "v": 0, "items": []any{item(chat, 1, 10)}}) // nothing to copy yet
	set(a, 404, map[string]any{"items": []any{item(xChat, 1, 10)}})                      // not a member there
	set(a, 400, map[string]any{"items": []any{item(chat, 9, 10)}})                       // no such key epoch
	set(a, 400, map[string]any{"items": []any{item(chat, 1, maxPicture+1)}})
	set(a, 200, map[string]any{"items": []any{item(chat, 1, 100)}})

	var got picture
	b.must(200, "GET", "/api/chats/"+itoa(chat)+"/avatars/"+itoa(a.user), nil, &got)
	if len(got.Body) != 100 || got.Epoch != 1 || got.V == 0 {
		t.Fatalf("avatar = %+v", got)
	}
	if code := x.do("GET", "/api/chats/"+itoa(chat)+"/avatars/"+itoa(a.user), nil, nil); code != 404 {
		t.Fatalf("outsider reads avatar: %d", code)
	}
	var list []struct {
		Members []member `json:"members"`
	}
	b.must(200, "GET", "/api/chats", nil, &list)
	for _, m := range list[0].Members {
		if m.ID == a.user && m.AvatarV != got.V {
			t.Fatalf("member avatar_v = %d, want %d", m.AvatarV, got.V)
		}
	}

	// copy keeps the version: a chat joined later catches up without
	// making every other chat look stale.
	chat2, _ := a.createChat("group", 1)
	set(a, 409, map[string]any{"copy": true, "v": got.V - 1, "items": []any{item(chat2, 1, 100)}}) // a newer one exists
	set(a, 200, map[string]any{"copy": true, "v": got.V, "items": []any{item(chat2, 1, 100)}})
	var me struct {
		User struct {
			AvatarV int64 `json:"avatar_v"`
		} `json:"user"`
	}
	a.must(200, "GET", "/api/me", nil, &me)
	if me.User.AvatarV != got.V {
		t.Fatalf("me.avatar_v = %d, want %d", me.User.AvatarV, got.V)
	}

	// Group photo: groups only, removable.
	direct, _ := a.createChat("direct", 1)
	if code := a.do("PUT", "/api/chats/"+itoa(direct)+"/photo", map[string]any{"epoch": 1, "body": []byte("p")}, nil); code != 400 {
		t.Fatalf("photo on a direct chat: %d", code)
	}
	if code := x.do("PUT", "/api/chats/"+itoa(chat)+"/photo", map[string]any{"epoch": 1, "body": []byte("p")}, nil); code != 404 {
		t.Fatalf("outsider sets photo: %d", code)
	}
	b.must(200, "PUT", "/api/chats/"+itoa(chat)+"/photo", map[string]any{"epoch": 1, "body": []byte("photo")}, nil)
	a.must(200, "GET", "/api/chats/"+itoa(chat)+"/photo", nil, &got)
	if string(got.Body) != "photo" {
		t.Fatalf("photo = %q", got.Body)
	}
	b.must(200, "PUT", "/api/chats/"+itoa(chat)+"/photo", map[string]any{"epoch": 0, "body": nil}, nil)
	if code := a.do("GET", "/api/chats/"+itoa(chat)+"/photo", nil, nil); code != 404 {
		t.Fatalf("removed photo: %d", code)
	}
}

func TestPublicAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"93.184.215.14:443":          true,
		"93.184.215.14:80":           true,
		"[2606:4700:4700::1111]:443": true,
		"93.184.215.14:22":           false, // only web ports
		"127.0.0.1:80":               false,
		"10.1.2.3:443":               false,
		"172.18.0.5:80":              false, // docker networks
		"192.168.1.1:80":             false,
		"169.254.169.254:80":         false, // cloud metadata
		"100.64.0.1:80":              false,
		"0.0.0.0:80":                 false,
		"[::1]:443":                  false,
		"[::ffff:127.0.0.1]:80":      false, // IPv4-mapped loopback
		"[fd00::1]:443":              false,
		"[fe80::1]:443":              false,
		"[64:ff9b::a00:1]:443":       false, // NAT64 to 10.0.0.1
		"224.0.0.1:80":               false,
		"not-an-address":             false,
	} {
		if got := publicAddr(addr); got != want {
			t.Errorf("publicAddr(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestLinkPreview(t *testing.T) {
	site := http.NewServeMux()
	site.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/page", http.StatusFound) })
	site.HandleFunc("/page", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<html><head><title>Fallback</title>
			<meta content="Море &amp; горы" property="og:title">
			<meta name='description' content='Отпуск в августе'>
			<meta property="og:image" content="/pic.png"></head><body>hi</body></html>`))
	})
	site.HandleFunc("/pic.png", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("png bytes"))
	})
	srv := httptest.NewServer(site)
	defer srv.Close()

	open := newPreviewClient(func(string) bool { return true })
	u, _ := url.Parse(srv.URL + "/old")
	p, err := fetchPreview(context.Background(), open, u)
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "Море & горы" || p.Desc != "Отпуск в августе" || string(p.Image) != "png bytes" {
		t.Fatalf("preview = %+v", p)
	}

	// Every hop is checked: an allowed first server cannot redirect into a
	// refused one.
	inner := httptest.NewServer(site)
	defer inner.Close()
	outer := httptest.NewServer(http.RedirectHandler(inner.URL+"/page", http.StatusFound))
	defer outer.Close()
	onlyOuter := newPreviewClient(func(addr string) bool { return "http://"+addr == outer.URL })
	ou, _ := url.Parse(outer.URL)
	if _, err := fetchPreview(context.Background(), onlyOuter, ou); err == nil {
		t.Fatal("followed a redirect to a refused address")
	}

	// The real client refuses the loopback test server, redirect or not.
	if _, err := fetchPreview(context.Background(), newPreviewClient(publicAddr), u); err == nil {
		t.Fatal("fetched from a loopback address")
	}
	e := newEnv(t)
	a := e.register("A")
	if code := a.do("POST", "/api/preview", map[string]any{"url": srv.URL + "/page"}, nil); code != 404 {
		t.Fatalf("preview of a private address: %d", code)
	}
	if code := a.do("POST", "/api/preview", map[string]any{"url": "file:///etc/passwd"}, nil); code != 400 {
		t.Fatalf("file URL: %d", code)
	}
}
