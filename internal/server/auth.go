package server

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/time/rate"
)

//go:embed words.txt
var wordList string

var words = strings.Fields(wordList)

const (
	sessionCookie = "sid"
	sessionTTL    = 180 * 24 * time.Hour
)

// Auth is the caller resolved from the session cookie.
type Auth struct {
	UserID   int64
	DeviceID int64
	Status   string
	Name     string
}

type authed func(http.ResponseWriter, *http.Request, *Auth)

// --- passwords ---

// newPassword builds "WordWord_1234": two concrete words from a ~3500-word
// list plus four digits, about 37 bits. Enough because guessing is rate limited and a
// password alone only yields a pending device without any chat keys.
func newPassword() string {
	pick := func(n int) int {
		v, _ := rand.Int(rand.Reader, big.NewInt(int64(n)))
		return int(v.Int64())
	}
	title := func(w string) string { return strings.ToUpper(w[:1]) + w[1:] }
	return fmt.Sprintf("%s%s_%04d", title(words[pick(len(words))]), title(words[pick(len(words))]), pick(10000))
}

// normalizePassword makes login forgiving: case and separators do not
// matter, so "dimondcrown3213" matches "DimondCrown_3213".
func normalizePassword(p string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(p) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// lookupKey is the stored form of a password. The password is also the
// account identifier, so the salt is a fixed server-side pepper (never in
// the DB) instead of a per-user salt.
func (s *Server) lookupKey(ctx context.Context, password string) ([]byte, error) {
	select {
	case s.argon <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.argon }()
	return argon2.IDKey([]byte(normalizePassword(password)), s.cfg.Pepper, 1, 64*1024, 2, 32), nil
}

// --- sessions ---

func (s *Server) startSession(ctx context.Context, w http.ResponseWriter, q execer, deviceID int64) error {
	token := randomBytes(32)
	if _, err := q.ExecContext(ctx, `INSERT INTO sessions (token_hash, device_id, expires_at) VALUES (?, ?, ?)`,
		sha(token), deviceID, time.Now().Add(sessionTTL).UnixMilli()); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: b64(token), Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteStrictMode,
	})
	return nil
}

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func (s *Server) session(r *http.Request) (*Auth, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, err
	}
	token, err := decodeB64(c.Value)
	if err != nil {
		return nil, err
	}
	a := &Auth{}
	var expires int64
	err = s.db.QueryRowContext(r.Context(), `SELECT d.user_id, d.id, d.status, u.name, s.expires_at
		FROM sessions s JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = d.user_id
		WHERE s.token_hash = ?`, sha(token)).Scan(&a.UserID, &a.DeviceID, &a.Status, &a.Name, &expires)
	if err != nil {
		return nil, err
	}
	if expires < now() || a.Status == "revoked" {
		return nil, errors.New("session expired")
	}
	// Sliding expiry, written at most once a day.
	if fresh := time.Now().Add(sessionTTL).UnixMilli(); fresh-expires > 24*3600*1000 {
		if _, err := s.db.ExecContext(r.Context(), `UPDATE sessions SET expires_at = ? WHERE token_hash = ?`, fresh, sha(token)); err != nil {
			s.log.Warn("extend session", "err", err)
		}
		if _, err := s.db.ExecContext(r.Context(), `UPDATE devices SET last_seen = ? WHERE id = ?`, now(), a.DeviceID); err != nil {
			s.log.Warn("device last seen", "err", err)
		}
	}
	return a, nil
}

// anyDevice lets pending devices through (they wait for approval).
func (s *Server) anyDevice(h authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, err := s.session(r)
		if err != nil {
			fail(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r, a)
	}
}

// active requires an approved device.
func (s *Server) active(h authed) http.HandlerFunc {
	return s.anyDevice(func(w http.ResponseWriter, r *http.Request, a *Auth) {
		if a.Status != "active" {
			fail(w, http.StatusForbidden, "device_pending")
			return
		}
		h(w, r, a)
	})
}

// --- device keys ---

type devicePub struct {
	EncPub []byte `json:"enc_pub"`
	SigPub []byte `json:"sig_pub"`
	Label  string `json:"label"`
}

func (d *devicePub) valid() bool {
	if _, err := ecdh.P256().NewPublicKey(d.EncPub); err != nil {
		return false
	}
	if _, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), d.SigPub); err != nil {
		return false
	}
	d.Label = truncate(strings.TrimSpace(d.Label), 64)
	if d.Label == "" {
		d.Label = "?"
	}
	return true
}

// verifySig checks a WebCrypto ECDSA P-256/SHA-256 signature, which comes
// as raw r||s (IEEE P1363), not ASN.1.
func verifySig(pub, msg, sig []byte) bool {
	key, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), pub)
	if err != nil || len(sig) != 64 {
		return false
	}
	h := sha256.Sum256(msg)
	return ecdsa.Verify(key, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func insertDevice(ctx context.Context, tx *sql.Tx, userID int64, d devicePub, status string) (int64, error) {
	res, err := tx.ExecContext(ctx, `INSERT INTO devices (user_id, enc_pub, sig_pub, label, status, created_at, last_seen)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, userID, d.EncPub, d.SigPub, d.Label, status, now(), now())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// --- login ---

type nonces struct {
	mu sync.Mutex
	m  map[string]time.Time
}

func newNonces() *nonces { return &nonces{m: map[string]time.Time{}} }

func (n *nonces) issue() []byte {
	b := randomBytes(32)
	n.mu.Lock()
	n.m[string(b)] = time.Now().Add(2 * time.Minute)
	n.mu.Unlock()
	return b
}

func (n *nonces) take(b []byte) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	exp, ok := n.m[string(b)]
	delete(n.m, string(b))
	return ok && time.Now().Before(exp)
}

func (n *nonces) prune() {
	n.mu.Lock()
	defer n.mu.Unlock()
	for k, exp := range n.m {
		if time.Now().After(exp) {
			delete(n.m, k)
		}
	}
}

func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if !s.auth.allow(s.clientIP(r)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nonce": s.nonce.issue()})
}

var loginPrefix = []byte("connect-login:")

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string     `json:"password"`
		DeviceID int64      `json:"device_id"`
		Nonce    []byte     `json:"nonce"`
		Sig      []byte     `json:"sig"`
		Device   *devicePub `json:"device"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !s.auth.allow(s.clientIP(r)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}

	// Known device: its signature is checked before the password, so this
	// path is no password oracle and does not draw on the global budget of
	// failed logins (which an attacker could otherwise drain for everyone).
	var owner int64
	var status string
	if req.DeviceID != 0 {
		var sigPub []byte
		err := s.db.QueryRowContext(r.Context(), `SELECT user_id, status, sig_pub FROM devices WHERE id = ?`, req.DeviceID).
			Scan(&owner, &status, &sigPub)
		if err != nil || status == "revoked" {
			fail(w, http.StatusGone, "device_revoked")
			return
		}
		if !s.nonce.take(req.Nonce) || !verifySig(sigPub, append(append([]byte{}, loginPrefix...), req.Nonce...), req.Sig) {
			fail(w, http.StatusUnauthorized, "bad_signature")
			return
		}
	} else if !s.auth.globalOK() {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}

	key, err := s.lookupKey(r.Context(), req.Password)
	if err != nil {
		s.internal(w, err)
		return
	}
	var userID int64
	err = s.db.QueryRowContext(r.Context(), `SELECT id FROM users WHERE pass_lookup = ?`, key).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		if req.DeviceID == 0 {
			s.auth.failed()
		}
		fail(w, http.StatusUnauthorized, "bad_password")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}

	if req.DeviceID != 0 {
		if owner != userID {
			fail(w, http.StatusConflict, "device_mismatch")
			return
		}
		if err := s.startSession(r.Context(), w, s.db, req.DeviceID); err != nil {
			s.internal(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"device_id": req.DeviceID, "status": status})
		return
	}

	// New device: pending until an existing device (or a chat partner)
	// hands it chat keys. Only a user with neither chats nor a working
	// device gets in on the password alone: there is nothing to protect
	// and nobody who could approve.
	if req.Device == nil || !req.Device.valid() {
		fail(w, http.StatusBadRequest, "bad_device")
		return
	}
	var deviceID int64
	status = "pending"
	err = inTx(r.Context(), s.db, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(r.Context(), `SELECT (SELECT COUNT(*) FROM members WHERE user_id = ?) +
			(SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'active')`, userID, userID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			status = "active"
		}
		var err error
		if deviceID, err = insertDevice(r.Context(), tx, userID, *req.Device, status); err != nil {
			return err
		}
		return s.startSession(r.Context(), w, tx, deviceID)
	})
	if err != nil {
		s.internal(w, err)
		return
	}
	if status == "pending" {
		s.hub.toUsers([]int64{userID}, event{"t": "device"})
		s.push.notifyDevices(r.Context(), userID, deviceID, map[string]any{"t": "device", "label": req.Device.Label})
	}
	writeJSON(w, http.StatusOK, map[string]any{"device_id": deviceID, "status": status})
}

// handleChangePassword swaps the password for a fresh generated one. The
// current password is required, so a borrowed unlocked phone cannot lock
// its owner out. Sessions and devices stay as they are.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !s.auth.allow(s.clientIP(r)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	key, err := s.lookupKey(r.Context(), req.Password)
	if err != nil {
		s.internal(w, err)
		return
	}
	var owner int64
	if err := s.db.QueryRowContext(r.Context(), `SELECT id FROM users WHERE pass_lookup = ?`, key).Scan(&owner); err != nil || owner != a.UserID {
		fail(w, http.StatusUnauthorized, "bad_password")
		return
	}
	password := newPassword()
	next, err := s.lookupKey(r.Context(), password)
	if err != nil {
		s.internal(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `UPDATE users SET pass_lookup = ? WHERE id = ?`, next, a.UserID); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"password": password})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, a *Auth) {
	if err := s.revokeDevice(r.Context(), a.UserID, a.DeviceID); err != nil {
		s.internal(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		Secure: s.cfg.CookieSecure, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, a *Auth) {
	var hide bool
	var created int64
	var recovery bool
	var avatarV int64
	err := s.db.QueryRowContext(r.Context(), `SELECT u.hide_online, u.created_at, u.avatar_v, d.recovery FROM users u
		JOIN devices d ON d.user_id = u.id WHERE u.id = ? AND d.id = ?`, a.UserID, a.DeviceID).Scan(&hide, &created, &avatarV, &recovery)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   map[string]any{"id": a.UserID, "name": a.Name, "hide_online": hide, "created_at": created, "avatar_v": avatarV},
		"device": map[string]any{"id": a.DeviceID, "status": a.Status, "recovery": recovery},
	})
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Name       *string `json:"name"`
		HideOnline *bool   `json:"hide_online"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Name != nil {
		name, ok := cleanName(*req.Name)
		if !ok {
			fail(w, http.StatusBadRequest, "bad_name")
			return
		}
		if _, err := s.db.ExecContext(r.Context(), `UPDATE users SET name = ? WHERE id = ?`, name, a.UserID); err != nil {
			s.internal(w, err)
			return
		}
	}
	if req.HideOnline != nil {
		if _, err := s.db.ExecContext(r.Context(), `UPDATE users SET hide_online = ? WHERE id = ?`, *req.HideOnline, a.UserID); err != nil {
			s.internal(w, err)
			return
		}
	}
	s.broadcastUser(r.Context(), a.UserID)
	writeJSON(w, http.StatusOK, map[string]any{})
}

func cleanName(n string) (string, bool) {
	n = strings.Join(strings.FieldsFunc(n, unicode.IsSpace), " ")
	n = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, n)
	l := utf8.RuneCountInString(n)
	return n, l >= 1 && l <= 40
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// --- rate limits ---

// limiters throttles password and invite guessing per IP, plus a global
// cap on failed logins so a botnet cannot spread guesses across IPs.
type limiters struct {
	mu     sync.Mutex
	ips    map[string]*ipLimit
	global *rate.Limiter
}

type ipLimit struct {
	l    *rate.Limiter
	seen time.Time
}

func newLimiters() *limiters {
	return &limiters{ips: map[string]*ipLimit{}, global: rate.NewLimiter(rate.Every(time.Second), 60)}
}

func (l *limiters) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.ips[ip]
	if !ok {
		e = &ipLimit{l: rate.NewLimiter(rate.Every(10*time.Second), 10)}
		l.ips[ip] = e
	}
	e.seen = time.Now()
	return e.l.Allow()
}

func (l *limiters) globalOK() bool { return l.global.Tokens() >= 1 }
func (l *limiters) failed()        { l.global.Allow() }

func (l *limiters) prune() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for ip, e := range l.ips {
		if time.Since(e.seen) > 30*time.Minute {
			delete(l.ips, ip)
		}
	}
}

func decodeB64(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
