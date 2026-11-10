package server

import (
	"bytes"
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
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// fcm sends pushes to the Android app through Firebase Cloud Messaging
// (HTTP v1). The body is the same JSON a Web Push carries: ciphertext and
// ids only, decrypted on the phone. Google sees when and how much.
//
// It signs its own OAuth assertion with the project's service account key
// (RS256 JWT bearer flow) rather than pulling in Google's SDKs. The key
// lives only on the server (FCM_CREDENTIALS), never in the repository.
type fcm struct {
	project, email string
	key            *rsa.PrivateKey
	client         *http.Client
	tokenURL       string // Google's, fixed: a key file cannot send its assertion elsewhere
	sendURL        string
	now            func() time.Time

	mu      sync.Mutex
	access  string
	expires time.Time
}

const (
	fcmTokenURL = "https://oauth2.googleapis.com/token"
	fcmScope    = "https://www.googleapis.com/auth/firebase.messaging"
	fcmPrefix   = "fcm:" // push_subs.endpoint of an Android app's device
)

func newFCM(keyJSON []byte, client *http.Client) (*fcm, error) {
	var sa struct {
		Type       string `json:"type"`
		ProjectID  string `json:"project_id"`
		Email      string `json:"client_email"`
		PrivateKey string `json:"private_key"`
	}
	if err := json.Unmarshal(keyJSON, &sa); err != nil {
		return nil, fmt.Errorf("read fcm service account: %w", err)
	}
	if sa.Type != "service_account" || sa.ProjectID == "" || sa.Email == "" {
		return nil, errors.New("fcm service account: not a service account key")
	}
	block, _ := pem.Decode([]byte(sa.PrivateKey))
	if block == nil {
		return nil, errors.New("fcm service account: no private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("fcm service account key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("fcm service account: not an RSA key")
	}
	return &fcm{
		project: sa.ProjectID, email: sa.Email, key: key, client: client,
		tokenURL: fcmTokenURL,
		sendURL:  "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(sa.ProjectID) + "/messages:send",
		now:      time.Now,
	}, nil
}

// errFCMGone: the app was removed or its token replaced; drop the token.
var errFCMGone = errors.New("fcm token gone")

// send delivers one data message. Rings and messages go at high priority,
// which wakes a phone in Doze. A read or a call taken elsewhere shows
// nothing, and FCM demotes apps whose urgent messages show nothing; a phone
// still ringing is awake anyway.
func (f *fcm) send(ctx context.Context, token string, body []byte, topic string, ttl int) error {
	access, err := f.token(ctx)
	if err != nil {
		return err
	}
	var kind struct {
		T string `json:"t"`
	}
	_ = json.Unmarshal(body, &kind)
	priority := "HIGH"
	if kind.T == "read" || kind.T == "callEnd" {
		priority = "NORMAL"
	}
	android := map[string]any{"priority": priority, "ttl": fmt.Sprintf("%ds", ttl)}
	// A ring still waiting for an offline phone is replaced by the next
	// one. Not per chat: Android keeps only four collapse keys at a time.
	if topic == "call" || topic == "gcall" {
		android["collapse_key"] = topic
	}
	msg, _ := json.Marshal(map[string]any{"message": map[string]any{
		"token":   token,
		"data":    map[string]string{"p": string(body)},
		"android": android,
	}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.sendURL, bytes.NewReader(msg))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("fcm send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 300 {
		return nil
	}
	var e struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode       string `json:"errorCode"`
				FieldViolations []struct {
					Field string `json:"field"`
				} `json:"fieldViolations"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&e)
	if resp.StatusCode == http.StatusUnauthorized {
		f.mu.Lock()
		f.access = "" // revoked or expired early: a new one next time
		f.mu.Unlock()
	}
	// Only an answer about this token drops it. A key from another project
	// (SENDER_ID_MISMATCH) or a wrong project id (a bare 404) would
	// otherwise wipe every app's token on the first push: an error instead.
	for _, d := range e.Error.Details {
		if d.ErrorCode == "UNREGISTERED" {
			return errFCMGone
		}
		for _, v := range d.FieldViolations {
			if v.Field == "message.token" {
				return errFCMGone
			}
		}
	}
	return fmt.Errorf("fcm send: %d %s", resp.StatusCode, e.Error.Status)
}

// token returns a cached access token, or trades a fresh signed assertion
// for one. A failed trade is not cached: the next push tries again.
func (f *fcm) token(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if f.access != "" && now.Before(f.expires) {
		return f.access, nil
	}
	assertion, err := f.assertion(now)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := f.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fcm token: %w", err)
	}
	defer resp.Body.Close()
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fcm token: status %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&t); err != nil || t.AccessToken == "" {
		return "", fmt.Errorf("fcm token: unreadable answer: %v", err)
	}
	// Renewed five minutes early, so a push never carries one about to lapse.
	f.access, f.expires = t.AccessToken, now.Add(time.Duration(t.ExpiresIn)*time.Second-5*time.Minute)
	return f.access, nil
}

// assertion is the RS256 JWT Google's token endpoint takes from a service
// account: who, for what, valid for an hour.
func (f *fcm) assertion(now time.Time) (string, error) {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss": f.email, "scope": fcmScope, "aud": fcmTokenURL,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	signed := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signed))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("sign fcm assertion: %w", err)
	}
	return signed + "." + enc.EncodeToString(sig), nil
}

// validFCMToken: what the app may register. FCM tokens are a few hundred
// URL-safe characters with a colon; anything else is not one.
func validFCMToken(t string) bool {
	if len(t) < 32 || len(t) > 4096 {
		return false
	}
	for _, r := range t {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-', r == ':':
		default:
			return false
		}
	}
	return true
}
