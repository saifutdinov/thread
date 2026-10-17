package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func (c *user) upload(chat int64, data []byte) string {
	c.t.Helper()
	req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/media?chat=%d", c.base, chat), bytes.NewReader(data))
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.ID == "" {
		c.t.Fatalf("upload: %d %v", resp.StatusCode, err)
	}
	return out.ID
}

func TestMigrationsAreRecordedAndIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.db")
	for range 2 { // second open must not re-run anything
		db, err := openDB(path)
		if err != nil {
			t.Fatal(err)
		}
		var v int
		if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		if v != len(migrations) {
			t.Fatalf("user_version = %d, want %d", v, len(migrations))
		}
		if _, err := db.Exec(`SELECT pinned FROM chats`); err != nil {
			t.Fatalf("pinned column missing: %v", err)
		}
		db.Close()
	}
}

func TestPinning(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chatID, _ := a.createChat("group", 1)
	other, _ := a.createChat("group", 1)
	_, m := a.send(chatID, 1, "m1")
	_, foreign := a.send(other, 1, "m2")

	a.must(200, "PUT", fmt.Sprintf("/api/chats/%d/pin", chatID), map[string]any{"id": m.ID}, nil)
	var chats []chat
	a.must(200, "GET", "/api/chats", nil, &chats)
	for _, c := range chats {
		if c.ID == chatID && (c.Pinned != m.ID || c.PinnedMsg == nil || c.PinnedMsg.ID != m.ID) {
			t.Fatalf("pinned not reported: %+v", c)
		}
	}
	if code := a.do("PUT", fmt.Sprintf("/api/chats/%d/pin", chatID), map[string]any{"id": foreign.ID}, nil); code != 400 {
		t.Fatalf("pinning another chat's message: %d", code)
	}
	x := e.register("X")
	if code := x.do("PUT", fmt.Sprintf("/api/chats/%d/pin", chatID), map[string]any{"id": m.ID}, nil); code != 404 {
		t.Fatalf("outsider pinning: %d", code)
	}
	// Deleting the message drops the pin.
	a.must(200, "DELETE", fmt.Sprintf("/api/messages/%d", m.ID), nil, nil)
	chats = nil
	a.must(200, "GET", "/api/chats", nil, &chats)
	for _, c := range chats {
		if c.ID == chatID && (c.Pinned != 0 || c.PinnedMsg != nil) {
			t.Fatalf("pin survived the deleted message: %+v", c)
		}
	}
}

func TestForwardCopiesMediaOnlyBetweenOwnChats(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	src, _ := a.createChat("group", 1)
	dst, key := a.createChat("group", 1)
	b := e.join(key, "B") // in dst only
	id := a.upload(src, []byte("ciphertext"))

	x := e.register("X")
	xChat, _ := x.createChat("group", 1)
	if code := x.do("POST", "/api/media/"+id+"/copy", map[string]any{"chat": xChat}, nil); code != 404 {
		t.Fatalf("outsider copying media: %d", code)
	}
	if code := a.do("POST", "/api/media/"+id+"/copy", map[string]any{"chat": xChat}, nil); code != 404 {
		t.Fatalf("copying into a chat the caller is not in: %d", code)
	}
	var out struct {
		ID string `json:"id"`
	}
	a.must(200, "POST", "/api/media/"+id+"/copy", map[string]any{"chat": dst}, &out)
	if out.ID == "" || out.ID == id {
		t.Fatalf("copy id = %q", out.ID)
	}
	resp, err := b.hc.Get(b.base + "/api/media/" + out.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || buf.String() != "ciphertext" {
		t.Fatalf("member of the target chat: %d %q", resp.StatusCode, buf.String())
	}
	if code := b.do("GET", "/api/media/"+id, nil, nil); code != 404 {
		t.Fatalf("original stays private to its chat: %d", code)
	}
}

func TestMetrics(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	a.do("GET", "/api/nope", nil, nil)
	a.socket(t)

	scrape := func() string {
		rec := httptest.NewRecorder()
		e.s.metricsHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
		return rec.Body.String()
	}
	out := scrape()
	for _, want := range []string{`thread_http_responses_total{code="4xx"} 1`, "thread_sockets 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("metrics lack %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "thread_backup") {
		t.Error("backup metrics exported while backups are off")
	}

	id, _ := age.GenerateX25519Identity()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	if err := e.s.backup(context.Background(), time.Unix(1_800_000_000, 0)); err != nil {
		t.Fatal(err)
	}
	if out := scrape(); !strings.Contains(out, "thread_backup_last_success_timestamp_seconds 1800000000") {
		t.Errorf("backup time missing:\n%s", out)
	}
}
