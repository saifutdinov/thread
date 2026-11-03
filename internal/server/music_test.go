package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSpotifyTrack(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"},
		{" https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc ", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"},
		{"https://open.spotify.com/intl-pt-BR/track/4uLU6hMCjMI75M1A2tKUQC/", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"},
		{"spotify:track:4uLU6hMCjMI75M1A2tKUQC", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"},
		{"http://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", ""},
		{"https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC", ""},
		{"https://open.spotify.com.evil.example/track/4uLU6hMCjMI75M1A2tKUQC", ""},
		{"https://open.spotify.com/track/short", ""},
		{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", ""},
	} {
		if got := spotifyTrack(c.in); got != c.want {
			t.Errorf("spotifyTrack(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Music by link: the sidecar gets the canonical track link and hands back
// the audio; the server passes it to the one who asked, once, and keeps
// nothing. One fetch at a time; off without MUSIC_URL.
func TestMusic(t *testing.T) {
	const link = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
	off := newEnv(t)
	off.register("A").must(404, "POST", "/api/music", map[string]any{"url": link}, nil) // no sidecar configured

	release := make(chan struct{})
	asked := make(chan string, 4)
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			URL string `json:"url"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		asked <- req.URL
		<-release
		if strings.HasSuffix(req.URL, "0000000000000000000000") {
			http.Error(w, "no match", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "audio/mp4")
		w.Header().Set("X-Title", url.PathEscape("Песня"))
		w.Header().Set("X-Artist", url.PathEscape("Кто-то"))
		_, _ = io.WriteString(w, "AUDIO")
	}))
	defer sidecar.Close()
	e := newEnv(t, func(c *Config) { c.MusicURL = sidecar.URL })
	a := e.register("A")
	b := e.register("B")

	a.must(400, "POST", "/api/music", map[string]any{"url": "https://example.com/x"}, nil)
	var job struct {
		ID string `json:"id"`
	}
	a.must(202, "POST", "/api/music", map[string]any{"url": link + "?si=x"}, &job)
	b.must(429, "POST", "/api/music", map[string]any{"url": link}, nil) // one at a time
	a.must(202, "GET", "/api/music/"+job.ID, nil, nil)                  // still fetching
	b.must(404, "GET", "/api/music/"+job.ID, nil, nil)                  // not theirs
	close(release)

	body, h := waitMusic(t, a, job.ID)
	if body != "AUDIO" || h.Get("Content-Type") != "audio/mp4" || h.Get("X-Title") != url.PathEscape("Песня") || h.Get("X-Artist") != url.PathEscape("Кто-то") {
		t.Fatalf("got %q %v", body, h)
	}
	if got := <-asked; got != link {
		t.Fatalf("sidecar asked %q", got)
	}
	a.must(404, "GET", "/api/music/"+job.ID, nil, nil) // handed over once, gone

	// Not found by the sidecar: the job ends with its code.
	a.must(202, "POST", "/api/music", map[string]any{"url": "https://open.spotify.com/track/0000000000000000000000"}, &job)
	var out struct {
		Error string `json:"error"`
	}
	for i := 0; ; i++ {
		if a.do("GET", "/api/music/"+job.ID, nil, &out) != http.StatusAccepted {
			break
		}
		if i > 200 {
			t.Fatal("still fetching")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if out.Error != "music_not_found" {
		t.Fatalf("error %q", out.Error)
	}

	// /api/me tells the app whether music by link is on.
	var me struct {
		Music bool `json:"music"`
	}
	a.must(200, "GET", "/api/me", nil, &me)
	if !me.Music {
		t.Fatal("music not announced")
	}
}

// A finished job nobody came for is gone after a while: its audio does
// not stay in memory, nor is it handed out late.
func TestMusicJobExpires(t *testing.T) {
	m := newMusicJobs()
	id, _ := m.start(1)
	m.finish(id, musicJob{mime: "audio/mp4", data: []byte("x")})
	m.mu.Lock()
	m.jobs[id].finished = time.Now().Add(-musicKeep - time.Second)
	m.mu.Unlock()
	if _, ok := m.take(id, 1); ok {
		t.Fatal("an expired job was handed out")
	}
	if id2, ok := m.start(2); !ok || id2 == id {
		t.Fatal("the slot was not free again")
	}
}

// waitMusic polls the job until it is done and returns the file.
func waitMusic(t *testing.T, u *user, id string) (string, http.Header) {
	t.Helper()
	for i := 0; i < 200; i++ {
		req, _ := http.NewRequest("GET", u.base+"/api/music/"+id, nil)
		resp, err := u.hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return string(b), resp.Header
		}
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("status %d: %s", resp.StatusCode, b)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("still fetching")
	return "", nil
}
