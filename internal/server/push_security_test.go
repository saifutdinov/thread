package server

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPushEndpointRequiresHTTPS(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.1/private", "https://user:pass@example.com/push", "https://example.com:444/push", "https://example.com/push#fragment", "/relative", "not a url"} {
		if validPushEndpoint(endpoint) {
			t.Errorf("accepted endpoint %q", endpoint)
		}
	}
	if !validPushEndpoint("https://fcm.googleapis.com/fcm/send/token") {
		t.Fatal("valid push endpoint rejected")
	}
}

func TestPendingDeviceCannotRegisterOrTestPush(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	pending := e.newUser()
	pending.must(200, "POST", "/api/auth/login", map[string]any{"password": a.pass, "device": pending.dev.pub()}, nil)
	pending.must(403, "POST", "/api/push", map[string]any{"endpoint": "https://example.com/push", "keys": map[string]string{"p256dh": "k", "auth": "a"}}, nil)
	pending.must(403, "POST", "/api/push/test", map[string]any{}, nil)
}

func TestPushClientBlocksResolvedPrivateAddresses(t *testing.T) {
	e := newEnv(t)
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	// A pre-existing subscription is checked at delivery too. The endpoint
	// resolves to loopback: delivery must fail before opening a connection.
	checked := ""
	client := newPushClient(func(address string) bool { checked = address; return publicAddr(address) })
	e.s.push.client = client
	e.s.push.webPush(sub{endpoint: "https://127.0.0.1/push", p256dh: enc(key.PublicKey().Bytes()), auth: enc(make([]byte, 16))}, []byte("test"), "test", 30)
	if checked == "" || !strings.HasPrefix(checked, "127.0.0.1:") || e.s.push.failed.Load() != 1 {
		t.Fatalf("private push: checked=%q failures=%d", checked, e.s.push.failed.Load())
	}
}

func TestPushClientDoesNotFollowRedirects(t *testing.T) {
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { reached.Store(true); w.WriteHeader(200) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	c := newPushClient(func(string) bool { return true }) // allow our test listener only for this test
	req, err := http.NewRequestWithContext(context.Background(), "POST", source.URL, strings.NewReader("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	r, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	_, _ = io.Copy(io.Discard, r.Body)
	if reached.Load() || r.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("followed redirect: reached=%v status=%d", reached.Load(), r.StatusCode)
	}
}
