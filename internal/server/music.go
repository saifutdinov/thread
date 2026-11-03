package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Music by link (ADR 0004): a Spotify track link goes to the music sidecar
// (deploy/music, spotDL), which finds the track's audio and hands it back.
// The browser that asked takes it once, encrypts it and sends it like any
// file. The server and the sidecar see which track was asked for and the
// audio itself, never which chat it goes to; nothing is kept on disk.
// A download can outlast a proxy's read timeout, so it is a job: POST
// starts it, GET takes the file once it is there. Off without MUSIC_URL.

const (
	musicTimeout = 5 * time.Minute
	musicKeep    = 10 * time.Minute // a finished job nobody took is dropped
	// The plaintext limit (MAX_FILE in store.ts): maxUpload adds the cipher's 28 bytes.
	maxTrack = maxUpload - 12 - 16
)

var spotifyTrackRE = regexp.MustCompile(`^(?:https://open\.spotify\.com/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?/)?track/|spotify:track:)([0-9A-Za-z]{22})(?:[/?#].*)?$`)

// spotifyTrack returns the canonical link of a Spotify track, "" for
// anything else: the sidecar is asked for tracks only.
func spotifyTrack(link string) string {
	m := spotifyTrackRE.FindStringSubmatch(strings.TrimSpace(link))
	if m == nil {
		return ""
	}
	return "https://open.spotify.com/track/" + m[1]
}

type musicJob struct {
	user                int64
	done                bool
	code                string // the error once done, "" when it worked
	mime, title, artist string
	data                []byte
	finished            time.Time
}

// musicJobs: one fetch at a time for the whole server (the sidecar runs
// one download at a time too), results held in memory until taken.
// ponytail: a single slot, a queue if several people fetch at once often.
type musicJobs struct {
	mu   sync.Mutex
	busy bool
	jobs map[string]*musicJob
	keep time.Duration
}

func newMusicJobs() *musicJobs { return &musicJobs{jobs: map[string]*musicJob{}, keep: musicKeep} }

func (m *musicJobs) start(user int64) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy {
		return "", false
	}
	m.busy = true
	id := hex.EncodeToString(randomBytes(16))
	m.jobs[id] = &musicJob{user: user}
	return id, true
}

func (m *musicJobs) finish(id string, res musicJob) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.busy = false
	if j := m.jobs[id]; j != nil {
		res.user, res.done, res.finished = j.user, true, time.Now()
		m.jobs[id] = &res
		// Nobody came for it (the tab closed): the audio leaves memory.
		time.AfterFunc(m.keep, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			delete(m.jobs, id)
		})
	}
}

// take returns the user's job; a finished one is handed over only once.
func (m *musicJobs) take(id string, user int64) (musicJob, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.jobs[id]
	if j == nil || j.user != user {
		return musicJob{}, false
	}
	if j.done && time.Since(j.finished) > m.keep {
		delete(m.jobs, id)
		return musicJob{}, false
	}
	if j.done {
		delete(m.jobs, id)
	}
	return *j, true
}

func (s *Server) handleMusic(w http.ResponseWriter, r *http.Request, a *Auth) {
	if s.cfg.MusicURL == "" {
		fail(w, http.StatusNotFound, "music_off")
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	track := spotifyTrack(req.URL)
	if track == "" {
		fail(w, http.StatusBadRequest, "music_link")
		return
	}
	id, ok := s.music.start(a.UserID)
	if !ok {
		fail(w, http.StatusTooManyRequests, "music_busy")
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(s.wsCtx, musicTimeout)
		defer cancel()
		s.music.finish(id, s.fetchMusic(ctx, track))
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id})
}

// fetchMusic asks the sidecar for one track.
func (s *Server) fetchMusic(ctx context.Context, track string) musicJob {
	body, _ := json.Marshal(map[string]string{"url": track})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.MusicURL, "/")+"/fetch", bytes.NewReader(body))
	if err != nil {
		return musicJob{code: "music_failed"}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.log.Warn("music sidecar", "err", err)
		return musicJob{code: "music_failed"}
	}
	defer resp.Body.Close()
	mime := resp.Header.Get("Content-Type")
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return musicJob{code: "music_not_found"}
	case resp.StatusCode != http.StatusOK || !strings.HasPrefix(mime, "audio/"):
		s.log.Warn("music sidecar", "status", resp.StatusCode, "type", mime)
		return musicJob{code: "music_failed"}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxTrack+1))
	switch {
	case err != nil:
		s.log.Warn("music sidecar", "err", err)
		return musicJob{code: "music_failed"}
	case len(data) > maxTrack:
		return musicJob{code: "too_large"}
	}
	clip := func(v string) string { return v[:min(len(v), 4096)] } // 300 characters, percent-encoded
	return musicJob{mime: mime, title: clip(resp.Header.Get("X-Title")), artist: clip(resp.Header.Get("X-Artist")), data: data}
}

func (s *Server) handleMusicJob(w http.ResponseWriter, r *http.Request, a *Auth) {
	j, ok := s.music.take(r.PathValue("id"), a.UserID)
	switch {
	case !ok:
		fail(w, http.StatusNotFound, "not_found")
	case !j.done:
		writeJSON(w, http.StatusAccepted, map[string]any{"pending": true})
	case j.code == "music_not_found":
		fail(w, http.StatusNotFound, j.code)
	case j.code == "too_large":
		fail(w, http.StatusRequestEntityTooLarge, j.code)
	case j.code != "":
		fail(w, http.StatusBadGateway, j.code)
	default:
		h := w.Header()
		h.Set("Content-Type", j.mime)
		h.Set("Content-Length", strconv.Itoa(len(j.data)))
		h.Set("Cache-Control", "no-store")
		// Percent-encoded UTF-8 from the sidecar, decoded by the browser.
		h.Set("X-Title", j.title)
		h.Set("X-Artist", j.artist)
		_, _ = w.Write(j.data)
	}
}
