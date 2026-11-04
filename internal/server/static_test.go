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

	for _, tc := range []struct {
		accept string
		br     bool
	}{
		{"br;q=0", false},
		{"gzip, br;q=0.0", false},
		{"BR", true},
		{"gzip;q=1, br;q=0.5", true},
	} {
		resp, body := get(tc.accept)
		if (resp.Header.Get("Content-Encoding") == "br") != tc.br || (body == "brotli wasm") != tc.br {
			t.Errorf("Accept-Encoding %q: got %q %q", tc.accept, resp.Header.Get("Content-Encoding"), body)
		}
	}

	// No brotli copy: the file as it is.
	if err := os.WriteFile(filepath.Join(assets, "y.wasm"), []byte("only raw"), 0o644); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", e.ts.URL+"/assets/y.wasm", nil)
	req.Header.Set("Accept-Encoding", "br")
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "only raw" || resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("missing .br: %q %v", b, resp.Header)
	}

	// HEAD gets the same headers and no body.
	req, _ = http.NewRequest("HEAD", e.ts.URL+"/assets/x.wasm", nil)
	req.Header.Set("Accept-Encoding", "br")
	resp, err = rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Encoding") != "br" || resp.Header.Get("Content-Length") != "11" {
		t.Fatalf("HEAD: %d %v", resp.StatusCode, resp.Header)
	}
}

// The microphone worklets carry their model: 4.8 MB that must arrive inside
// a call's setup budget. Their names do not change, so they are revalidated.
func TestStaticServesBrotliAudioWorklet(t *testing.T) {
	e := newEnv(t)
	audio := filepath.Join(e.s.cfg.StaticDir, "audio")
	if err := os.MkdirAll(audio, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"x-worklet.js": "raw js", "x-worklet.js.br": "brotli js"} {
		if err := os.WriteFile(filepath.Join(audio, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rt := &http.Transport{DisableCompression: true}
	get := func(accept, since string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", e.ts.URL+"/audio/x-worklet.js", nil)
		req.Header.Set("Accept-Encoding", accept)
		if since != "" {
			req.Header.Set("If-Modified-Since", since)
		}
		resp, err := rt.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	resp, body := get("gzip, br", "")
	if resp.StatusCode != 200 || body != "brotli js" || resp.Header.Get("Content-Encoding") != "br" {
		t.Fatalf("br: %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/javascript") || resp.Header.Get("Cache-Control") != "no-cache" ||
		!strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("br headers: %v", resp.Header)
	}
	if resp, _ := get("br", resp.Header.Get("Last-Modified")); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("revalidation: %d", resp.StatusCode)
	}

	resp, body = get("gzip", "")
	if body != "raw js" || resp.Header.Get("Content-Encoding") != "" || !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("no br: %q %v", body, resp.Header)
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
