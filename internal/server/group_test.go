package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLiveKitToken(t *testing.T) {
	at := time.Unix(1_800_000_000, 0)
	tok := liveKitToken("connect", "s3cret", "room-1", "7.12", at)
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token = %q", tok)
	}
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if parts[2] != base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatal("not an HS256 signature over header.claims")
	}
	var head struct{ Alg, Typ string }
	var claims struct {
		Iss, Sub string
		Nbf, Exp int64
		Video    struct {
			Room                                               string
			RoomJoin, CanPublish, CanSubscribe, CanPublishData bool
		}
	}
	for i, v := range []any{&head, &claims} {
		b, err := base64.RawURLEncoding.DecodeString(parts[i])
		if err != nil || json.Unmarshal(b, v) != nil {
			t.Fatalf("part %d: %s", i, b)
		}
	}
	if head.Alg != "HS256" || head.Typ != "JWT" {
		t.Fatalf("header = %+v", head)
	}
	v := claims.Video
	if claims.Iss != "connect" || claims.Sub != "7.12" || v.Room != "room-1" || !v.RoomJoin || !v.CanPublish || !v.CanSubscribe || !v.CanPublishData {
		t.Fatalf("claims = %+v", claims)
	}
	// Short-lived: it only opens the connection, LiveKit refreshes it after.
	if claims.Nbf > at.Unix() || claims.Exp-at.Unix() != int64(liveKitTTL.Seconds()) {
		t.Fatalf("nbf %d exp %d", claims.Nbf, claims.Exp)
	}
}

type groupJoin struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	Token string `json:"token"`
	E     int    `json:"e"`
	Key   []byte `json:"key"`
	V     bool   `json:"v"`
}

// roomOf reads the LiveKit room out of a token.
func roomOf(t *testing.T, tok string) string {
	t.Helper()
	parts := strings.Split(tok, ".")
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct{ Video struct{ Room string } }
	if err != nil || json.Unmarshal(b, &claims) != nil {
		t.Fatalf("token %q", tok)
	}
	return claims.Video.Room
}

type groupList struct {
	On    bool `json:"on"`
	Calls []struct {
		C     int64   `json:"c"`
		ID    string  `json:"id"`
		Users []int64 `json:"users"`
	} `json:"calls"`
}

func TestGroupCall(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("group", 5)
	b := e.join(key, "B")
	c := e.join(key, "C")
	x := e.register("X")
	start := map[string]any{"id": "group-call-1", "v": true, "e": 1, "key": []byte("sealed call key")}
	path := "/api/chats/" + itoa(chat) + "/call"

	var list groupList
	a.must(200, "GET", "/api/calls/group", nil, &list)
	if list.On {
		t.Fatal("group calls on without LiveKit configured")
	}
	a.must(404, "POST", path, start, nil)

	e.s.cfg.LiveKitURL, e.s.cfg.LiveKitKey, e.s.cfg.LiveKitSecret = "http://sfu:7880", "connect", "s3cret"
	// Who is in a call goes by the app's socket: no socket, no joining.
	a.must(409, "POST", path, start, nil)
	a.socket(t)
	wb, wc := b.socket(t), c.socket(t)

	x.must(404, "POST", path, start, nil) // not a member
	a.must(400, "POST", path, map[string]any{"id": "bad id!", "e": 1, "key": []byte("k")}, nil)

	var ja groupJoin
	a.must(200, "POST", path, start, &ja)
	if ja.ID != "group-call-1" || ja.URL != "/lk" || ja.Token == "" || ja.E != 1 || string(ja.Key) != "sealed call key" || !ja.V {
		t.Fatalf("start = %+v", ja)
	}
	if room := roomOf(t, ja.Token); room != "c"+itoa(chat)+"-group-call-1" {
		t.Fatalf("room = %q", room)
	}
	for _, w := range []*sock{wb, wc} {
		ring := expectCall(t, w, "ring")
		if ring["c"] != float64(chat) || ring["id"] != "group-call-1" || ring["from"] != float64(a.user) || ring["v"] != true {
			t.Fatalf("ring = %v", ring)
		}
		expectCall(t, w, "state")
	}

	// B joins the running call: its key, not a new one (also when B
	// started one at the same moment).
	wb2 := b.socket(t) // a second tab of the same device
	var jb groupJoin
	b.must(200, "POST", path, map[string]any{"id": "other-call", "e": 2, "key": []byte("other key")}, &jb)
	if jb.ID != "group-call-1" || string(jb.Key) != "sealed call key" || jb.E != 1 || roomOf(t, jb.Token) != roomOf(t, ja.Token) {
		t.Fatalf("join = %+v", jb)
	}
	if st := expectCall(t, wc, "state"); len(st["users"].([]any)) != 2 {
		t.Fatalf("state = %v", st)
	}
	// One of B's tabs closes, the other is still there: B stays in.
	wb2.conn.CloseNow()
	expectCall(t, wc, "")
	c.must(200, "GET", "/api/calls/group", nil, &list)
	if !list.On || len(list.Calls) != 1 || list.Calls[0].C != chat || list.Calls[0].ID != "group-call-1" || len(list.Calls[0].Users) != 2 {
		t.Fatalf("list = %+v", list)
	}
	x.must(200, "GET", "/api/calls/group", nil, &list)
	if len(list.Calls) != 0 {
		t.Fatalf("an outsider sees %+v", list.Calls)
	}

	e.s.groups.max = 2
	c.must(409, "POST", path, nil, nil) // full
	e.s.groups.max = groupMax

	a.must(200, "DELETE", path, nil, nil)
	if st := expectCall(t, wc, "state"); len(st["users"].([]any)) != 1 {
		t.Fatalf("after A left: %v", st)
	}

	// B's app closes: it is out of the call, and the empty call is over.
	wb.conn.CloseNow()
	if st := expectCall(t, wc, "state"); len(st["users"].([]any)) != 0 {
		t.Fatalf("after B's socket closed: %v", st)
	}
	c.must(200, "GET", "/api/calls/group", nil, &list)
	if len(list.Calls) != 0 {
		t.Fatalf("an empty call stays listed: %+v", list.Calls)
	}

	// A call this server forgot (a restart) comes back from the apps in it,
	// without ringing anyone again.
	var jr groupJoin
	c.must(200, "POST", path, map[string]any{"id": "group-call-1", "e": 1, "key": []byte("sealed call key"), "rejoin": true}, &jr)
	if jr.ID != "group-call-1" || string(jr.Key) != "sealed call key" {
		t.Fatalf("rejoin = %+v", jr)
	}
	if st := expectCall(t, wc, "state"); len(st["users"].([]any)) != 1 {
		t.Fatalf("after rejoin: %v", st)
	}

	// A call id kept from this chat does not lead into its room from another chat.
	other, _ := c.createChat("group", 1)
	var jo groupJoin
	c.must(200, "POST", "/api/chats/"+itoa(other)+"/call", start, &jo)
	if roomOf(t, jo.Token) == roomOf(t, jr.Token) {
		t.Fatal("another chat's call got the same LiveKit room")
	}

	direct, _ := a.createChat("direct", 1)
	a.must(400, "POST", "/api/chats/"+itoa(direct)+"/call", start, nil) // 1:1 calls stay device to device
}

func TestLiveKitProxy(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	var got string
	sfu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RequestURI()
		if r.Header.Get("Cookie") != "" {
			t.Error("our session cookie reached LiveKit")
		}
		w.Write([]byte("{}"))
	}))
	defer sfu.Close()

	a.must(404, "GET", "/lk/rtc/validate?access_token=t", nil, nil) // off until configured
	e.s.cfg.LiveKitURL, e.s.cfg.LiveKitKey, e.s.cfg.LiveKitSecret = sfu.URL, "connect", "s3cret"
	a.must(200, "GET", "/lk/rtc/validate?access_token=t", nil, nil)
	if got != "/rtc/validate?access_token=t" {
		t.Fatalf("LiveKit got %q", got)
	}
	// Only signed-in devices reach the SFU at all.
	if code := e.newUser().do("GET", "/lk/rtc/validate", nil, nil); code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d", code)
	}
}

// fakeRoomService stands in for LiveKit's RoomService: it lists the room's
// people and records who is removed, checking the admin pass.
type fakeRoomService struct {
	mu      sync.Mutex
	people  []string
	removed []string
}

func (f *fakeRoomService) serve(t *testing.T, secret string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Room, Identity string }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("body: %v", err)
		}
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		parts := strings.Split(tok, ".")
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(parts[0] + "." + parts[1]))
		b, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims struct {
			Video struct {
				Room      string
				RoomAdmin bool
			}
		}
		if len(parts) != 3 || parts[2] != base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) || json.Unmarshal(b, &claims) != nil ||
			!claims.Video.RoomAdmin || claims.Video.Room != req.Room {
			t.Errorf("pass for %q: %s", req.Room, b)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants":
			var ps []map[string]string
			for _, id := range f.people {
				ps = append(ps, map[string]string{"identity": id})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"participants": ps})
		case "/twirp/livekit.RoomService/RemoveParticipant":
			f.removed = append(f.removed, req.Room+" "+req.Identity)
			_, _ = w.Write([]byte("{}"))
		default:
			t.Errorf("path %s", r.URL.Path)
		}
	}))
}

func (f *fakeRoomService) gone() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.removed...)
}

// Someone who leaves the group, or a device switched off, is taken out of
// the running call in LiveKit too: their pass is not enough to stay.
func TestGroupCallDropsTheRemoved(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("group", 5)
	b := e.join(key, "B")
	c := e.join(key, "C")
	room := "c" + itoa(chat) + "-drop-call-1"
	f := &fakeRoomService{people: []string{
		fmt.Sprintf("%d.%d.aa", a.user, a.id), fmt.Sprintf("%d.%d.bb", b.user, b.id), fmt.Sprintf("%d.%d.cc", c.user, c.id),
	}}
	sfu := f.serve(t, "s3cret")
	defer sfu.Close()
	e.s.cfg.LiveKitURL, e.s.cfg.LiveKitKey, e.s.cfg.LiveKitSecret = sfu.URL, "connect", "s3cret"
	a.socket(t)
	b.socket(t)
	c.socket(t)
	path := "/api/chats/" + itoa(chat) + "/call"
	a.must(200, "POST", path, map[string]any{"id": "drop-call-1", "e": 1, "key": []byte("k")}, nil)
	b.must(200, "POST", path, map[string]any{}, nil)
	c.must(200, "POST", path, map[string]any{}, nil)

	b.must(200, "DELETE", "/api/chats/"+itoa(chat), nil, nil)
	eventually(t, "B removed from LiveKit", func() bool { return len(f.gone()) == 1 })
	if g := f.gone(); g[0] != room+" "+f.people[1] {
		t.Fatalf("removed %v", g)
	}
	var list groupList
	a.must(200, "GET", "/api/calls/group", nil, &list)
	if len(list.Calls) != 1 || len(list.Calls[0].Users) != 2 {
		t.Fatalf("calls = %+v", list.Calls)
	}

	if err := e.s.revokeDevice(context.Background(), c.user, c.id); err != nil {
		t.Fatal(err)
	}
	eventually(t, "C's device removed from LiveKit", func() bool { return len(f.gone()) == 2 })
	if g := f.gone(); g[1] != room+" "+f.people[2] {
		t.Fatalf("removed %v", g)
	}
}
