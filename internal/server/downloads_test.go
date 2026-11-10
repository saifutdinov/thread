package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadsListAndServeOnlyInstallers(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.s.cfg.DownloadsDir = dir
	files := map[string]string{
		"Thread-Setup-0.23.1.exe":       "exe",
		"Thread-0.23.1-arm64.dmg":       "dmg",
		"Thread-0.23.1-x64.dmg":         "dmg2",
		"Thread-0.23.1-amd64.deb":       "deb",
		"Thread-0.23.1-x86_64.AppImage": "appimage",
		"Thread-0.23.1.apk":             "apk",
		"notes.txt":                     "not an installer",
		"SHA256SUMS.txt":                "abc123  Thread-0.23.1.apk\n",
		"manifest.json":                 `{"release":"v0.23.1"}`,
		"manifest.sig":                  "c2ln",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(t.TempDir(), "secret.apk"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// No session needed: the sign-in screen lists them.
	resp, err := http.Get(e.ts.URL + "/api/downloads")
	if err != nil {
		t.Fatal(err)
	}
	var list []download
	_ = json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	got := map[string]download{}
	for _, d := range list {
		got[d.Platform] = d
	}
	if len(list) != 6 || got["android"].Name != "Thread-0.23.1.apk" || got["android"].SHA256 != "abc123" || got["mac-arm"].Size != 3 ||
		got["windows"].Name != "Thread-Setup-0.23.1.exe" || got["windows"].Version != "0.23.1" {
		t.Fatalf("list = %+v", list)
	}

	resp, err = http.Get(e.ts.URL + "/api/downloads/Thread-0.23.1.apk")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "apk" || resp.Header.Get("Content-Type") != "application/vnd.android.package-archive" ||
		resp.Header.Get("Content-Disposition") != `attachment; filename="Thread-0.23.1.apk"` {
		t.Fatalf("apk: %d %q %v", resp.StatusCode, body, resp.Header)
	}

	// The signed manifest is served for the apps' updates, not listed.
	resp, err = http.Get(e.ts.URL + "/api/downloads/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != `{"release":"v0.23.1"}` || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("manifest: %d %q %v", resp.StatusCode, body, resp.Header)
	}

	for _, path := range []string{"notes.txt", "SHA256SUMS.txt", "..%2Fsecret.apk", "Thread-9.9.9.apk", "manifest.json.bak"} {
		resp, err := http.Get(e.ts.URL + "/api/downloads/" + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, resp.StatusCode)
		}
	}

	e.s.cfg.DownloadsDir = "" // not set up: an empty list, no files
	resp, err = http.Get(e.ts.URL + "/api/downloads")
	if err != nil {
		t.Fatal(err)
	}
	list = nil
	_ = json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(list) != 0 {
		t.Fatalf("without a directory: %d %v", resp.StatusCode, list)
	}
}
