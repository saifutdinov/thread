package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
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
	live    func(device int64) bool

	sent, expired, failed atomic.Int64
}

// live reports devices with an open socket: they get events there, and
// iOS punishes pushes that end up showing no notification.
func newPusher(ctx context.Context, db *sql.DB, subject string, live func(int64) bool, log *slog.Logger) (*pusher, error) {
	p := &pusher{db: db, log: log, subject: subject, live: live, sem: make(chan struct{}, 8)}
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
	p.send(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		JOIN members mb ON mb.user_id = d.user_id WHERE mb.chat_id = ? AND d.user_id <> ? AND d.status = 'active'`,
		payload, "c"+fmt.Sprint(m.Chat), 24*3600, m.Chat, from.UserID)
}

// notifyCall rings the callee's sleeping devices. A ring is useless after
// it stops, hence the short TTL.
func (p *pusher) notifyCall(ctx context.Context, chatID, callee int64, from string, video bool) {
	p.send(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		WHERE d.user_id = ? AND d.status = 'active'`, map[string]any{"t": "call", "c": chatID, "n": from, "v": video},
		"call", int(ringFor.Seconds()), callee)
}

// notifyDevices alerts a user's other devices, e.g. about a new login.
func (p *pusher) notifyDevices(ctx context.Context, userID, except int64, payload map[string]any) {
	p.send(ctx, `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN devices d ON d.id = p.device_id
		WHERE d.user_id = ? AND d.id <> ? AND d.status = 'active'`, payload, "device", 24*3600, userID, except)
}

func (p *pusher) send(ctx context.Context, q string, payload map[string]any, topic string, ttl int, args ...any) {
	rows, err := p.db.QueryContext(ctx, q, args...)
	if err != nil {
		p.log.Error("push targets", "err", err)
		return
	}
	subs := []sub{}
	for rows.Next() {
		var s sub
		if err := rows.Scan(&s.device, &s.endpoint, &s.p256dh, &s.auth); err == nil && !p.live(s.device) {
			subs = append(subs, s)
		}
	}
	rows.Close()
	body, _ := json.Marshal(payload)
	for _, s := range subs {
		go p.deliver(s, body, topic, ttl)
	}
}

func (p *pusher) deliver(s sub, body []byte, topic string, ttl int) {
	p.sem <- struct{}{}
	defer func() { <-p.sem }()
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
