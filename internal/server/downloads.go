package server

import (
	"bufio"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The apps' installers, served from DOWNLOADS_DIR: the owner builds them for
// this server in a fork (.github/workflows/ci.yml, apps-release) and
// scripts/apps.sh puts that release's files there (docs/apps.md). Public:
// the sign-in screen offers them, and a link can go to a friend who has no
// account yet.
// Only files named as CI names them are listed or served.
var downloadKinds = []struct {
	platform string
	name     *regexp.Regexp
}{
	{"windows", regexp.MustCompile(`^Thread-Setup-[0-9][0-9A-Za-z.-]*\.exe$`)},
	{"mac-arm", regexp.MustCompile(`^Thread-[0-9][0-9A-Za-z.-]*-arm64\.dmg$`)},
	{"mac-intel", regexp.MustCompile(`^Thread-[0-9][0-9A-Za-z.-]*-x64\.dmg$`)},
	{"linux-deb", regexp.MustCompile(`^Thread-[0-9][0-9A-Za-z.-]*-amd64\.deb$`)},
	{"linux-appimage", regexp.MustCompile(`^Thread-[0-9][0-9A-Za-z.-]*-x86_64\.AppImage$`)},
	{"android", regexp.MustCompile(`^Thread-[0-9][0-9A-Za-z.-]*\.apk$`)},
}

type download struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Version  string `json:"version,omitempty"` // from the name: the apps compare it with their own
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256,omitempty"`
}

var downloadVersion = regexp.MustCompile(`[0-9]+\.[0-9]+\.[0-9]+`)

// The update manifest CI writes and signs (docs/updates.md): served as is,
// the apps check its signature themselves.
var manifestFiles = map[string]string{"manifest.json": "application/json", "manifest.sig": "text/plain; charset=utf-8"}

func downloadPlatform(name string) string {
	for _, k := range downloadKinds {
		if k.name.MatchString(name) {
			return k.platform
		}
	}
	return ""
}

// downloads lists the installers in the directory, with their checksums
// from SHA256SUMS.txt when it is there. No directory: none.
func (s *Server) downloads() []download {
	out := []download{}
	if s.cfg.DownloadsDir == "" {
		return out
	}
	sums := map[string]string{}
	if f, err := os.Open(filepath.Join(s.cfg.DownloadsDir, "SHA256SUMS.txt")); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if sum, name, ok := strings.Cut(sc.Text(), "  "); ok {
				sums[name] = sum
			}
		}
		f.Close()
	}
	entries, err := os.ReadDir(s.cfg.DownloadsDir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		p := downloadPlatform(e.Name())
		info, err := e.Info()
		if p == "" || err != nil || !info.Mode().IsRegular() {
			continue
		}
		out = append(out, download{Name: e.Name(), Platform: p, Version: downloadVersion.FindString(e.Name()), Size: info.Size(), SHA256: sums[e.Name()]})
	}
	return out
}

func (s *Server) handleInstallers(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, http.StatusOK, s.downloads())
}

func (s *Server) handleInstaller(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	manifest, isManifest := manifestFiles[name]
	if s.cfg.DownloadsDir == "" || (downloadPlatform(name) == "" && !isManifest) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.DownloadsDir, name))
	if err != nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if isManifest {
		w.Header().Set("Content-Type", manifest)
		w.Header().Set("Cache-Control", "no-cache") // the same name for every release
		http.ServeContent(w, r, name, info.ModTime(), f)
		return
	}
	kind := "application/octet-stream"
	if strings.HasSuffix(name, ".apk") {
		kind = "application/vnd.android.package-archive" // Android offers to install it
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	// The version is in the name: a cached copy is the same file.
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, name, info.ModTime(), f)
}
