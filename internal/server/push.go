package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// pusher sends Web Push (VAPID). Payloads carry ciphertext only; the
// service worker decrypts them with the chat key stored on the device.
type pusher struct {
	db      *sql.DB
	log     *slog.Logger
	subject string
	pub     string
	priv    string
	sem     chan struct{}
	live    func(device int64) bool // a page in front: no push needed
	// connected: any socket, even a background tab's. Such a page clears
	// its own notifications from socket events, so silent pushes, which
	// Chromium allows only within a budget, skip it.
	connected func(device int64) bool
	post      func(s sub, body []byte, topic string, ttl int) // webPush; tests record instead

	// notified: the newest message pushed per (device, chat) since the
	// chat was read, so a read elsewhere can take those notifications back.
	// ponytail: in memory, lost on restart and pruned only by reads; at
	// most devices × chats entries, a family's worth.
	mu       sync.Mutex
	notified map[[2]int64]int64

	sent, expired, failed atomic.Int64
}

// live reports devices in front, with an open socket and a visible page:
// they get events there, and iOS punishes pushes that end up showing no
// notification.
func newPusher(ctx context.Context, db *sql.DB, subject string, live, connected func(int64) bool, log *slog.Logger) (*pusher, error) {
	p := &pusher{db: db, log: log, subject: subject, live: live, connected: connected, sem: make(chan struct{}, 8), notified: map[[2]int64]int64{}}
	p.post = p.webPush
	var err error
	if p.pub, err = metaGet(ctx, db, "vapid_pub"); err != nil {
		return nil, err
	}
	if p.priv, err = metaGet(ctx, db, "vapid_priv"); err != nil {
		return nil, err
	}
	if p.pub != "" {
		return p, nil
	}
	if p.priv, p.pub, err = webpush.GenerateVAPIDKeys(); err != nil {
		return nil, fmt.Errorf("generate vapid keys: %w", err)
	}
	if err := metaSet(ctx, db, "vapid_pub", p.pub); err != nil {
		return nil, err
	}
	return p, metaSet(ctx, db, "vapid_priv", p.priv)
}

func (s *Server) handlePushKey(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"key": s.push.pub})
}

func (s *Server) handleSubscribe(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Endpoint) < 10 || len(req.Endpoint) > 2048 || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO push_subs (device_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
		ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth`,
		a.DeviceID, req.Endpoint, req.Keys.P256dh, req.Keys.Auth)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *Server) handleUnsubscribe(w http.ResponseWriter, r *http.Request, a *Auth) {
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM push_subs WHERE device_id = ?`, a.DeviceID); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

type sub struct {
	device                 int64
	endpoint, p256dh, auth string
}

// notifyMessage pushes to recipients' devices that have no live socket.
// The body rides along only while it fits the ~4 KB push payload limit.
func (p *pusher) notifyMessage(ctx context.Context, m *message, from *Auth) {
	payload := map[string]any{"t": "msg", "c": m.Chat, "m": m.ID, "e": m.Epoch, "n": from.Name}
	if len(m.Body) <= 2400 {
		payload["b"] = m.Body
	}
	subs := p.asleep(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		JOIN members mb ON mb.user_id = d.user_id WHERE mb.chat_id = ? AND d.user_id <> ? AND d.status = 'active'`,
		m.Chat, from.UserID)
	// Marked before the pushes leave: a read racing them still finds them.
	p.mu.Lock()
	for _, s := range subs {
		p.notified[[2]int64{s.device, m.Chat}] = max(p.notified[[2]int64{s.device, m.Chat}], m.ID)
	}
	p.mu.Unlock()
	p.push(subs, payload, "c"+fmt.Sprint(m.Chat), 24*3600)
}

// silentOK: the push service lets a push close notifications without
// showing one. Apple revokes subscriptions that do that, Mozilla runs out
// of quota; Chromium's services (FCM, WNS) allow it.
func silentOK(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	h := u.Hostname()
	return !strings.HasSuffix(h, "push.apple.com") && !strings.HasSuffix(h, "mozilla.com")
}

// notifyRead takes back the chat's notifications up to message `upTo` on
// the user's other devices that got one: the chat was read somewhere.
// Same topic as the message push, so one still waiting for an offline
// phone is replaced. A read short of the newest pushed message keeps the
// mark: the full read later still clears that one.
func (p *pusher) notifyRead(ctx context.Context, userID, chatID, upTo int64) {
	subs := p.targets(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		WHERE d.user_id = ? AND d.status = 'active'`, userID)
	body, _ := json.Marshal(map[string]any{"t": "read", "c": chatID, "id": upTo})
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range subs {
		key := [2]int64{s.device, chatID}
		newest, ok := p.notified[key]
		if !ok {
			continue
		}
		if upTo >= newest {
			delete(p.notified, key)
		}
		if !p.connected(s.device) && silentOK(s.endpoint) {
			go p.deliver(s, body, "c"+fmt.Sprint(chatID), 24*3600)
		}
	}
}

// notifyCallEnd takes back the ring on the callee's other devices: the
// call was answered or declined somewhere. Topic "call" replaces a ring
// still waiting for an offline phone.
func (p *pusher) notifyCallEnd(ctx context.Context, callee int64) {
	subs := p.targets(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		WHERE d.user_id = ? AND d.status = 'active'`, callee)
	body, _ := json.Marshal(map[string]any{"t": "callEnd"})
	for _, s := range subs {
		if !p.connected(s.device) && silentOK(s.endpoint) {
			go p.deliver(s, body, "call", int(ringFor.Seconds()))
		}
	}
}

// handlePushTest pushes a test notification to this device, in front or
// not: the settings' check that the whole path works.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request, a *Auth) {
	if !s.auth.allow(fmt.Sprintf("pushtest:%d", a.DeviceID)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	subs := s.push.targets(r.Context(), `SELECT device_id, endpoint, p256dh, auth FROM push_subs WHERE device_id = ?`, a.DeviceID)
	body, _ := json.Marshal(map[string]any{"t": "test"})
	for _, sb := range subs {
		go s.push.deliver(sb, body, "test", 300)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": len(subs)})
}

// notifyCall rings the callee's sleeping devices. A ring is useless after
// it stops, hence the short TTL.
// The call id lets the notification's Decline button decline it without
// a page (handleCallDecline).
func (p *pusher) notifyCall(ctx context.Context, chatID, callee int64, from string, video bool, id string) {
	p.send(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		WHERE d.user_id = ? AND d.status = 'active'`, map[string]any{"t": "call", "c": chatID, "n": from, "v": video, "id": id},
		"call", int(ringFor.Seconds()), callee)
}

// notifyDevices alerts a user's other devices, e.g. about a new login.
func (p *pusher) notifyDevices(ctx context.Context, userID, except int64, payload map[string]any) {
	p.send(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		WHERE d.user_id = ? AND d.id <> ? AND d.status = 'active'`, payload, "device", 24*3600, userID, except)
}

// send pushes to the targets that are not in front.
func (p *pusher) send(ctx context.Context, q string, payload map[string]any, topic string, ttl int, args ...any) {
	p.push(p.asleep(ctx, q, args...), payload, topic, ttl)
}

// asleep: the targets whose page is not in front.
func (p *pusher) asleep(ctx context.Context, q string, args ...any) []sub {
	subs := []sub{}
	for _, s := range p.targets(ctx, q, args...) {
		if !p.live(s.device) {
			subs = append(subs, s)
		}
	}
	return subs
}

func (p *pusher) push(subs []sub, payload map[string]any, topic string, ttl int) {
	body, _ := json.Marshal(payload)
	for _, s := range subs {
		go p.deliver(s, body, topic, ttl)
	}
}

// targets reads push subscriptions (device_id, endpoint, p256dh, auth).
func (p *pusher) targets(ctx context.Context, q string, args ...any) []sub {
	rows, err := p.db.QueryContext(ctx, q, args...)
	if err != nil {
		p.log.Error("push targets", "err", err)
		return nil
	}
	defer rows.Close()
	subs := []sub{}
	for rows.Next() {
		var s sub
		if err := rows.Scan(&s.device, &s.endpoint, &s.p256dh, &s.auth); err == nil {
			subs = append(subs, s)
		}
	}
	return subs
}

func (p *pusher) deliver(s sub, body []byte, topic string, ttl int) {
	p.sem <- struct{}{}
	defer func() { <-p.sem }()
	p.post(s, body, topic, ttl)
}

func (p *pusher) webPush(s sub, body []byte, topic string, ttl int) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := webpush.SendNotificationWithContext(ctx, body, &webpush.Subscription{
		Endpoint: s.endpoint, Keys: webpush.Keys{P256dh: s.p256dh, Auth: s.auth},
	}, &webpush.Options{
		Subscriber: p.subject, VAPIDPublicKey: p.pub, VAPIDPrivateKey: p.priv,
		TTL: ttl, Urgency: webpush.UrgencyHigh, Topic: topic,
	})
	if err != nil {
		p.failed.Add(1)
		p.log.Warn("push failed", "device", s.device, "err", err)
		return
	}
	resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound:
		p.expired.Add(1)
		if _, err := p.db.Exec(`DELETE FROM push_subs WHERE device_id = ? AND endpoint = ?`, s.device, s.endpoint); err != nil {
			p.log.Warn("drop expired push subscription", "err", err)
		}
	case resp.StatusCode >= 400:
		p.failed.Add(1)
		p.log.Warn("push rejected", "device", s.device, "status", resp.StatusCode)
	default:
		p.sent.Add(1)
	}
}
