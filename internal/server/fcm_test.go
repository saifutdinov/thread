package server

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeGoogle plays Google's token endpoint and FCM's send endpoint. It
// checks the signed assertion against the service account's public key.
type fakeGoogle struct {
	t        *testing.T
	pub      *rsa.PublicKey
	tokens   atomic.Int32
	mu       sync.Mutex
	sent     []map[string]any
	sendCode int
	sendBody string
}

func (g *fakeGoogle) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/token":
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			http.Error(w, "grant", http.StatusBadRequest)
			return
		}
		parts := strings.Split(r.Form.Get("assertion"), ".")
		if len(parts) != 3 {
			http.Error(w, "jwt", http.StatusBadRequest)
			return
		}
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if rsa.VerifyPKCS1v15(g.pub, crypto.SHA256, sum[:], sig) != nil {
			http.Error(w, "signature", http.StatusUnauthorized)
			return
		}
		var claims map[string]any
		raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
		_ = json.Unmarshal(raw, &claims)
		if claims["iss"] != "push@example.iam.gserviceaccount.com" || claims["scope"] != fcmScope || claims["aud"] != fcmTokenURL {
			http.Error(w, "claims", http.StatusBadRequest)
			return
		}
		n := g.tokens.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": fmt.Sprintf("access-%d", n), "expires_in": 3600})
	case "/send":
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		m["auth"] = r.Header.Get("Authorization")
		g.mu.Lock()
		g.sent = append(g.sent, m)
		code, body := g.sendCode, g.sendBody
		g.mu.Unlock()
		if code != 0 {
			w.WriteHeader(code)
			_, _ = io.WriteString(w, body)
			return
		}
		_, _ = io.WriteString(w, `{"name":"projects/p/messages/1"}`)
	default:
		http.NotFound(w, r)
	}
}

func (g *fakeGoogle) last() map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.sent) == 0 {
		return nil
	}
	return g.sent[len(g.sent)-1]
}

func (g *fakeGoogle) fail(code int, body string) {
	g.mu.Lock()
	g.sendCode, g.sendBody = code, body
	g.mu.Unlock()
}

// newFakeFCM: an fcm sender wired to a fake Google, with a clock the test moves.
func newFakeFCM(t *testing.T) (*fcm, *fakeGoogle, *time.Time) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	sa, _ := json.Marshal(map[string]string{
		"type": "service_account", "project_id": "thread-test",
		"client_email": "push@example.iam.gserviceaccount.com",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"token_uri":    "https://attacker.example/token", // ignored: Google's is fixed
	})
	g := &fakeGoogle{t: t, pub: &key.PublicKey}
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	f, err := newFCM(sa, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	if f.tokenURL != fcmTokenURL || !strings.HasSuffix(f.sendURL, "/v1/projects/thread-test/messages:send") {
		t.Fatalf("urls = %s %s", f.tokenURL, f.sendURL)
	}
	f.tokenURL, f.sendURL = srv.URL+"/token", srv.URL+"/send"
	now := time.Unix(1_800_000_000, 0)
	f.now = func() time.Time { return now }
	return f, g, &now
}

func TestFCMSendsDataMessages(t *testing.T) {
	f, g, now := newFakeFCM(t)
	ctx := context.Background()
	body := `{"t":"call","c":7,"id":"abc"}`
	if err := f.send(ctx, "tok-1", []byte(body), "call", 45); err != nil {
		t.Fatal(err)
	}
	msg := g.last()["message"].(map[string]any)
	android := msg["android"].(map[string]any)
	if msg["token"] != "tok-1" || msg["data"].(map[string]any)["p"] != body || msg["notification"] != nil {
		t.Fatalf("message = %v", msg)
	}
	if android["priority"] != "HIGH" || android["ttl"] != "45s" || android["collapse_key"] != "call" {
		t.Fatalf("android = %v", android)
	}
	if g.last()["auth"] != "Bearer access-1" {
		t.Fatalf("auth = %v", g.last()["auth"])
	}

	// What shows nothing does not wake a phone; chat topics never collapse.
	for _, quiet := range []string{`{"t":"read","c":7,"id":3}`, `{"t":"callEnd","id":"abc"}`} {
		if err := f.send(ctx, "tok-1", []byte(quiet), "c7", 60); err != nil {
			t.Fatal(err)
		}
		android = g.last()["message"].(map[string]any)["android"].(map[string]any)
		if android["priority"] != "NORMAL" || android["collapse_key"] != nil {
			t.Fatalf("%s: android = %v", quiet, android)
		}
	}
	if g.tokens.Load() != 1 {
		t.Fatalf("token traded %d times, want once while valid", g.tokens.Load())
	}

	*now = now.Add(56 * time.Minute) // past the early renewal
	if err := f.send(ctx, "tok-1", []byte(`{"t":"msg"}`), "c7", 60); err != nil {
		t.Fatal(err)
	}
	if g.tokens.Load() != 2 || g.last()["auth"] != "Bearer access-2" {
		t.Fatalf("after expiry: %d tokens, auth %v", g.tokens.Load(), g.last()["auth"])
	}
}

func TestFCMErrors(t *testing.T) {
	cases := []struct {
		name string
		code int
		body string
		gone bool
	}{
		{"unregistered", 404, `{"error":{"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`, true},
		{"other project", 403, `{"error":{"status":"PERMISSION_DENIED","details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}`, false},
		{"wrong project id", 404, `{"error":{"status":"NOT_FOUND"}}`, false},
		{"bad token", 400, `{"error":{"status":"INVALID_ARGUMENT","details":[{"fieldViolations":[{"field":"message.token"}]}]}}`, true},
		{"bad payload", 400, `{"error":{"status":"INVALID_ARGUMENT","details":[{"fieldViolations":[{"field":"message.android.ttl"}]}]}}`, false},
		{"busy", 503, `{"error":{"status":"UNAVAILABLE"}}`, false},
		{"revoked", 401, `{"error":{"status":"UNAUTHENTICATED"}}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, g, _ := newFakeFCM(t)
			g.fail(c.code, c.body)
			err := f.send(context.Background(), "tok", []byte(`{"t":"msg"}`), "c1", 60)
			if err == nil || errors.Is(err, errFCMGone) != c.gone {
				t.Fatalf("err = %v, want gone=%v", err, c.gone)
			}
			if c.code == 401 && f.access != "" {
				t.Fatal("a rejected access token stays cached")
			}
		})
	}
}

func TestNewFCMRejectsBadKeys(t *testing.T) {
	for name, key := range map[string]string{
		"not json":     "{",
		"user account": `{"type":"authorized_user","project_id":"p","client_email":"e"}`,
		"no key":       `{"type":"service_account","project_id":"p","client_email":"e","private_key":"x"}`,
	} {
		if _, err := newFCM([]byte(key), http.DefaultClient); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValidFCMToken(t *testing.T) {
	good := "dQw4w9WgXcQ:APA91b" + strings.Repeat("Ab-_9", 30)
	for tok, want := range map[string]bool{
		good:                      true,
		"short:x":                 false,
		good + " ":                false,
		good + "/":                false,
		strings.Repeat("a", 4097): false,
	} {
		if validFCMToken(tok) != want {
			t.Errorf("validFCMToken(%.20q) != %v", tok, want)
		}
	}
}

// The app registers its token; a message reaches it through FCM, and a
// token FCM calls dead is dropped, as a gone Web Push endpoint is.
func TestAppDeviceGetsPushesThroughFCM(t *testing.T) {
	e := newEnv(t)
	f, g, _ := newFakeFCM(t)
	e.s.push.fcm = f
	a := e.register("A")
	chat, inv := a.createChat("direct", 1)
	b := e.join(inv, "B")
	a.rotate(chat, 2, a.id, b.id)
	token := "app:" + strings.Repeat("Tk_0-", 20)
	b.must(400, "POST", "/api/push/app", map[string]any{"token": "bad token"}, nil)
	b.must(200, "POST", "/api/push/app", map[string]any{"token": token}, nil)

	send := func(cid string) {
		a.must(200, "POST", fmt.Sprintf("/api/chats/%d/messages", chat), map[string]any{
			"cid": cid, "epoch": 2, "body": []byte("x"), "sig": randomBytes(64),
		}, nil)
	}
	send("one")
	eventually(t, "no FCM message", func() bool { return g.last() != nil })
	msg := g.last()["message"].(map[string]any)
	var p map[string]any
	_ = json.Unmarshal([]byte(msg["data"].(map[string]any)["p"].(string)), &p)
	if msg["token"] != token || p["t"] != "msg" || p["c"] != float64(chat) {
		t.Fatalf("message = %v, payload = %v", msg, p)
	}

	g.fail(404, `{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}`)
	send("two")
	eventually(t, "dead token kept", func() bool {
		var n int
		_ = e.s.db.QueryRow(`SELECT COUNT(*) FROM push_subs WHERE device_id = ?`, b.id).Scan(&n)
		return n == 0
	})
}

// A broken key file turns the app's pushes off; the chat still starts.
func TestBrokenFCMKeyKeepsServerUp(t *testing.T) {
	for name, key := range map[string]string{"broken": "{", "empty": "", "blank": " \n"} {
		t.Run(name, func(t *testing.T) {
			s, err := New(context.Background(), Config{DataDir: t.TempDir(), Pepper: make([]byte, 32), FCMKey: []byte(key)}, slog.New(slog.DiscardHandler))
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			defer s.Close()
			if s.push.fcm != nil {
				t.Fatal("fcm on without a key")
			}
		})
	}
}
