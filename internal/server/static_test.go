package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The face detector's WebAssembly goes out as its brotli copy to browsers
// that take br; others get the file as it is.
func TestStaticServesBrotliWasm(t *testing.T) {
	e := newEnv(t)
	assets := filepath.Join(e.s.cfg.StaticDir, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"x.wasm": "raw wasm", "x.wasm.br": "brotli wasm"} {
		if err := os.WriteFile(filepath.Join(assets, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A bare transport: http.Client would add and undo its own gzip.
	rt := &http.Transport{DisableCompression: true}
	get := func(accept string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", e.ts.URL+"/assets/x.wasm", nil)
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		resp, err := rt.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	resp, body := get("gzip, deflate, br")
	if resp.StatusCode != 200 || body != "brotli wasm" || resp.Header.Get("Content-Encoding") != "br" {
		t.Fatalf("br: %d %q %q", resp.StatusCode, body, resp.Header.Get("Content-Encoding"))
	}
	if resp.Header.Get("Content-Type") != "application/wasm" || !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") ||
		!strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("br headers: %v", resp.Header)
	}

	resp, body = get("gzip")
	if body != "raw wasm" || resp.Header.Get("Content-Encoding") != "" || resp.Header.Get("Content-Type") != "application/wasm" {
		t.Fatalf("no br: %q %v", body, resp.Header)
	}
	if !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("a cache must keep both: %v", resp.Header)
	}
}

// Effects run WebAssembly, which a CSP without 'wasm-unsafe-eval' forbids;
// JavaScript eval stays forbidden.
func TestCSPAllowsWasmOnly(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Get(e.ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	csp := resp.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval';") || strings.Contains(csp, "'unsafe-eval'") {
		t.Fatalf("CSP = %s", csp)
	}
}
