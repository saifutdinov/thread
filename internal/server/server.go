// Package server is the Thread backend: HTTP API, WebSocket fan-out and
// Web Push over a single SQLite database. It never sees plaintext: message
// bodies, reactions, titles and media arrive already encrypted by the
// browser (docs/adr/0001-e2ee-webcrypto.md).
package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"filippo.io/age"
)

type Config struct {
	Addr         string
	DataDir      string
	StaticDir    string
	BaseURL      string
	Pepper       []byte
	TrustProxy   bool
	CookieSecure bool
	VAPIDSubject string
	TurnURLs     []string
	TurnSecret   string
	BackupTo     string // age recipients, comma-separated; empty disables backups
	BackupKeep   int    // local snapshots kept
	MetricsAddr  string // internal Prometheus listener; empty disables it
	S3           S3Config
}

type Server struct {
	cfg   Config
	db    *sql.DB
	log   *slog.Logger
	hub   *hub
	push  *pusher
	auth  *limiters
	argon chan struct{}
	nonce *nonces
	ring  *ringing
	m     metrics

	preview *http.Client // link previews; tests swap the address check

	backupTo []age.Recipient
}

func New(ctx context.Context, cfg Config, log *slog.Logger) (*Server, error) {
	if err := os.MkdirAll(filepath.Join(cfg.DataDir, "media"), 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	backupTo, err := parseRecipients(cfg.BackupTo)
	if err != nil {
		return nil, fmt.Errorf("BACKUP_RECIPIENT: %w", err)
	}
	if cfg.S3.enabled() && len(backupTo) == 0 {
		return nil, errors.New("BACKUP_S3_* is set but BACKUP_RECIPIENT is not")
	}
	db, err := openDB(filepath.Join(cfg.DataDir, "thread.db"))
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:   cfg,
		db:    db,
		log:   log,
		hub:   newHub(),
		auth:  newLimiters(),
		argon: make(chan struct{}, 4), // Limit: 4 parallel argon2 hashes = 256 MiB peak
		nonce: newNonces(),
		ring:  newRinging(),

		preview:  newPreviewClient(publicAddr),
		backupTo: backupTo,
	}
	if s.push, err = newPusher(ctx, db, cfg.VAPIDSubject, s.hub.deviceOnline, log); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Server) Close() { s.db.Close() }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	mux.HandleFunc("POST /api/auth/challenge", s.handleChallenge)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.anyDevice(s.handleLogout))
	mux.HandleFunc("POST /api/auth/password", s.active(s.handleChangePassword))
	mux.HandleFunc("GET /api/me", s.anyDevice(s.handleMe))
	mux.HandleFunc("PATCH /api/me", s.active(s.handleUpdateMe))
	mux.HandleFunc("PUT /api/me/avatar", s.active(s.handleSetAvatar))

	mux.HandleFunc("POST /api/invites/peek", s.handlePeek)
	mux.HandleFunc("POST /api/invites/redeem", s.handleRedeem)
	mux.HandleFunc("DELETE /api/invites/{id}", s.active(s.handleDeleteInvite))

	mux.HandleFunc("GET /api/chats", s.active(s.handleChats))
	mux.HandleFunc("POST /api/chats", s.active(s.handleCreateChat))
	mux.HandleFunc("DELETE /api/chats/{id}", s.active(s.handleLeaveChat))
	mux.HandleFunc("GET /api/chats/{id}/invites", s.active(s.handleListInvites))
	mux.HandleFunc("POST /api/chats/{id}/invites", s.active(s.handleCreateInvite))
	mux.HandleFunc("GET /api/chats/{id}/messages", s.active(s.handleMessages))
	mux.HandleFunc("POST /api/chats/{id}/messages", s.active(s.handleSend))
	mux.HandleFunc("DELETE /api/chats/{id}/messages", s.active(s.handleClearHistory))
	mux.HandleFunc("POST /api/chats/{id}/read", s.active(s.handleRead))
	mux.HandleFunc("POST /api/chats/{id}/rotate", s.active(s.handleRotate))
	mux.HandleFunc("PUT /api/chats/{id}/pin", s.active(s.handlePin))
	mux.HandleFunc("GET /api/chats/{id}/devices", s.active(s.handleChatDevices))
	mux.HandleFunc("GET /api/chats/{id}/avatars/{user}", s.active(s.handleGetAvatar))
	mux.HandleFunc("GET /api/chats/{id}/photo", s.active(s.handleGetPhoto))
	mux.HandleFunc("PUT /api/chats/{id}/photo", s.active(s.handleSetPhoto))
	mux.HandleFunc("PATCH /api/messages/{id}", s.active(s.handleEdit))
	mux.HandleFunc("DELETE /api/messages/{id}", s.active(s.handleDeleteMessage))
	mux.HandleFunc("PUT /api/messages/{id}/reaction", s.active(s.handleReact))
	mux.HandleFunc("DELETE /api/messages/{id}/reaction", s.active(s.handleUnreact))
	mux.HandleFunc("GET /api/sync", s.active(s.handleSync))

	mux.HandleFunc("GET /api/keys", s.active(s.handleKeys))
	mux.HandleFunc("POST /api/keys", s.active(s.handleShareKeys))
	mux.HandleFunc("GET /api/devices", s.anyDevice(s.handleDevices))
	mux.HandleFunc("GET /api/devices/pub", s.active(s.handleDevicePubs))
	mux.HandleFunc("GET /api/pending", s.active(s.handlePending))
	mux.HandleFunc("POST /api/devices/recovery", s.anyDevice(s.handleRecovery))
	mux.HandleFunc("POST /api/devices/{id}/approve", s.active(s.handleApprove))
	mux.HandleFunc("POST /api/devices/{id}/revoke", s.active(s.handleRevoke))

	mux.HandleFunc("POST /api/media", s.active(s.handleUpload))
	mux.HandleFunc("GET /api/media/{id}", s.active(s.handleDownload))
	mux.HandleFunc("POST /api/media/{id}/copy", s.active(s.handleCopyMedia))

	mux.HandleFunc("GET /api/turn", s.active(s.handleTurn))
	mux.HandleFunc("POST /api/preview", s.active(s.handlePreview))
	mux.HandleFunc("GET /api/push/key", s.handlePushKey)
	mux.HandleFunc("POST /api/push", s.anyDevice(s.handleSubscribe))
	mux.HandleFunc("DELETE /api/push", s.anyDevice(s.handleUnsubscribe))

	mux.HandleFunc("GET /api/ws", s.anyDevice(s.handleWS))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) { fail(w, http.StatusNotFound, "not_found") })
	mux.Handle("/", s.static())

	return s.count(s.secure(mux))
}

// Run serves until ctx is cancelled, plus the hourly cleanup loop.
func (s *Server) Run(ctx context.Context) error {
	if err := s.bootstrap(ctx); err != nil {
		return err
	}
	go s.cleanupLoop(ctx)
	if len(s.backupTo) > 0 {
		go s.backupLoop(ctx)
	}
	if s.cfg.MetricsAddr != "" {
		ms := &http.Server{Addr: s.cfg.MetricsAddr, Handler: s.metricsHandler(), ReadHeaderTimeout: 10 * time.Second}
		go func() {
			<-ctx.Done()
			_ = ms.Close() // shutting down anyway; nothing to do with the error
		}()
		go func() {
			if err := ms.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				s.log.Error("metrics listener", "err", err)
			}
		}()
	}
	srv := &http.Server{
		Addr:              s.cfg.Addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			s.log.Warn("shutdown", "err", err)
		}
	}()
	s.log.Info("listening", "addr", s.cfg.Addr, "base_url", s.cfg.BaseURL)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) cleanupLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		s.cleanup(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) cleanup(ctx context.Context) {
	n := now()
	for _, q := range []string{
		`DELETE FROM invites WHERE expires_at < ?`,
		`DELETE FROM sessions WHERE expires_at < ?`,
	} {
		if _, err := s.db.ExecContext(ctx, q, n); err != nil {
			s.log.Error("cleanup", "err", err)
		}
	}
	// Uploads never attached to a message within a day are abandoned.
	ids, err := s.mediaIDs(ctx, `SELECT id FROM media WHERE message_id IS NULL AND created_at < ?`, n-24*3600*1000)
	if err == nil {
		err = s.deleteMedia(ctx, ids)
	}
	if err != nil {
		s.log.Error("cleanup media", "err", err)
	}
	s.auth.prune()
	s.nonce.prune()
}

// secure adds security headers and rejects cross-origin writes.
func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss://"+r.Host+" ws://"+r.Host+"; "+
			"worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
		if s.cfg.CookieSecure {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" {
				if u, err := url.Parse(o); err != nil || u.Host != r.Host {
					fail(w, http.StatusForbidden, "origin")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// static serves the built PWA with an index.html fallback for client routes.
func (s *Server) static() http.Handler {
	fs := http.FileServer(http.Dir(s.cfg.StaticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(s.cfg.StaticDir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			r.URL.Path = "/"
		}
		// The home-screen name follows the browser's first language.
		// Limit: first tag only, no q-values; enough for ru vs the rest.
		if r.URL.Path == "/manifest.webmanifest" {
			w.Header().Add("Vary", "Accept-Language")
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Accept-Language"))), "ru") {
				r.URL.Path = "/manifest.ru.webmanifest"
			}
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fs.ServeHTTP(w, r)
	})
}

// --- helpers ---

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "bad_json")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// fail answers with a stable machine-readable code the client translates.
func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) internal(w http.ResponseWriter, err error) {
	s.log.Error("internal error", "err", err)
	fail(w, http.StatusInternalServerError, "internal")
}

func pathID(r *http.Request) (int64, bool) {
	var id int64
	_, err := fmt.Sscan(r.PathValue("id"), &id)
	return id, err == nil && id > 0
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func sha(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if ip := r.Header.Get("X-Real-IP"); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
