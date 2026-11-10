package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The browser answers the protocol's pings by itself and the page never sees
// them. The page asks with an event of its own: an answer means the socket
// still carries events.
func TestWSAnswersPagePing(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	u, _ := url.Parse(a.base)
	h := http.Header{}
	for _, ck := range a.hc.Jar.Cookies(u) {
		h.Add("Cookie", ck.Name+"="+ck.Value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(a.base, "http")+"/api/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("no pong: %v", err)
		}
		var ev map[string]any
		if json.Unmarshal(b, &ev) == nil && ev["t"] == "pong" {
			return
		}
	}
}
