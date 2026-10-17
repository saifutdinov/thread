package server

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

// Link previews, only for people who switched them on: the sender's
// browser asks the server to fetch the page (so the server sees that one
// link), builds the card and sends it inside the encrypted message.
// Recipients never fetch anything.
//
// The fetcher only talks to public addresses on ports 80/443. The check
// runs in the dialer on the resolved address of every connection, so DNS
// rebinding and redirects into the private network are refused too.

var errBlockedAddr = errors.New("preview: address not allowed")

func publicAddr(address string) bool {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return false
	}
	ip := ap.Addr().Unmap()
	if p := ap.Port(); p != 80 && p != 443 {
		return false
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// IPv6: only real global unicast. That leaves out NAT64, IPv4-compatible
	// and site-local forms, which can lead back into IPv4 private ranges.
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, block := range []netip.Prefix{
		netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
		netip.MustParsePrefix("240.0.0.0/4"),   // reserved
		netip.MustParsePrefix("2001::/32"),     // Teredo
		netip.MustParsePrefix("2002::/16"),     // 6to4
	} {
		if block.Contains(ip) {
			return false
		}
	}
	return true
}

func newPreviewClient(allow func(string) bool) *http.Client {
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			if !allow(address) {
				return errBlockedAddr
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  5 * time.Second,
			MaxResponseHeaderBytes: 64 << 10,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 4 || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
}

// linkPreview has no URL of its own: the card links to what the person
// typed, never to where a redirect (or this server) says it went.
type linkPreview struct {
	Site  string `json:"site,omitempty"`
	Title string `json:"title,omitempty"`
	Desc  string `json:"desc,omitempty"`
	Image []byte `json:"image,omitempty"` // the browser shrinks it into the card
}

func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request, a *Auth) {
	var req struct {
		URL string `json:"url"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(req.URL) > 2048 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if !s.auth.allow(fmt.Sprintf("preview:%d", a.UserID)) {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	p, err := fetchPreview(r.Context(), s.preview, u)
	if err != nil {
		// Unreachable, not HTML, nothing to show: the message just goes
		// out without a card. Not worth an error log line.
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func fetchPreview(ctx context.Context, hc *http.Client, u *url.URL) (*linkPreview, error) {
	body, final, ctype, err := fetchLimited(ctx, hc, u.String(), 512<<10)
	if err != nil {
		return nil, err
	}
	if mt, _, _ := mime.ParseMediaType(ctype); mt != "text/html" && mt != "application/xhtml+xml" {
		return nil, errors.New("preview: not html")
	}
	meta := parseMeta(body)
	p := &linkPreview{
		Site:  clip(firstOf(meta["og:site_name"], final.Hostname()), 80),
		Title: clip(firstOf(meta["og:title"], meta["twitter:title"], meta["title"]), 200),
		Desc:  clip(firstOf(meta["og:description"], meta["twitter:description"], meta["description"]), 300),
	}
	if p.Title == "" && p.Desc == "" {
		return nil, errors.New("preview: nothing to show")
	}
	if src := firstOf(meta["og:image"], meta["twitter:image"]); src != "" {
		if iu, err := final.Parse(src); err == nil && (iu.Scheme == "http" || iu.Scheme == "https") {
			img, _, ct, err := fetchLimited(ctx, hc, iu.String(), 2<<20)
			if mt, _, _ := mime.ParseMediaType(ct); err == nil && strings.HasPrefix(mt, "image/") && mt != "image/svg+xml" {
				p.Image = img
			}
		}
	}
	return p, nil
}

func fetchLimited(ctx context.Context, hc *http.Client, target string, limit int64) ([]byte, *url.URL, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, "", err
	}
	// An honest bot name with a link back, so site owners know who asks.
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ThreadLinkPreview/1.0; +https://github.com/saifutdinov/thread)")
	req.Header.Set("Accept", "text/html,image/*;q=0.8")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, "", fmt.Errorf("preview: %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, nil, "", err
	}
	if int64(len(b)) > limit {
		if strings.HasPrefix(resp.Header.Get("Content-Type"), "image/") {
			return nil, nil, "", errors.New("preview: image too large")
		}
		b = b[:limit] // the head of a page is enough for its meta tags
	}
	return b, resp.Request.URL, resp.Header.Get("Content-Type"), nil
}

var (
	metaTag   = regexp.MustCompile(`(?is)<meta\s[^>]*>`)
	attr      = regexp.MustCompile(`(?is)([a-z:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	titleTag  = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	collapsed = regexp.MustCompile(`\s+`)
)

// parseMeta reads og:/twitter: tags, the description and the <title>.
// Limit: regexes over the page head, UTF-8 only; pages in other
// charsets just get no card. Add x/net/html + charset if that matters.
func parseMeta(page []byte) map[string]string {
	out := map[string]string{}
	if !utf8.Valid(page) {
		return out
	}
	for _, tag := range metaTag.FindAllString(string(page), 200) {
		attrs := map[string]string{}
		for _, m := range attr.FindAllStringSubmatch(tag, -1) {
			attrs[strings.ToLower(m[1])] = strings.Trim(m[2], `"'`)
		}
		key := strings.ToLower(firstOf(attrs["property"], attrs["name"]))
		if key != "" && attrs["content"] != "" && out[key] == "" {
			out[key] = html.UnescapeString(attrs["content"])
		}
	}
	if m := titleTag.FindStringSubmatch(string(page)); m != nil {
		out["title"] = html.UnescapeString(m[1])
	}
	return out
}

func firstOf(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func clip(s string, n int) string {
	s = strings.TrimSpace(collapsed.ReplaceAllString(s, " "))
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}
