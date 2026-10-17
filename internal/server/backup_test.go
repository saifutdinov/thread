package server

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"
)

// The "GET Object" example from the AWS Signature V4 documentation.
func TestSignV4MatchesAWSExample(t *testing.T) {
	r, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	r.Header.Set("Range", "bytes=0-9")
	r.Header.Set("x-amz-content-sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
	signV4(r, S3Config{Region: "us-east-1", AccessKey: "AKIAIOSFODNN7EXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"},
		time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := r.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization =\n%s\nwant\n%s", got, want)
	}
}

type fakeS3 struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut || !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=key/") {
		http.Error(w, "denied", http.StatusForbidden)
		return
	}
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objs[strings.TrimPrefix(r.URL.Path, "/bucket/")] = b
}

func (f *fakeS3) keys(prefix string) (out []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k := range f.objs {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	return out
}

func TestBackup(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	attached, loose := a.upload(chat, []byte("sealed photo")), a.upload(chat, []byte("not sent yet"))
	if _, err := e.s.db.Exec(`UPDATE media SET message_id = 1 WHERE id = ?`, attached); err != nil {
		t.Fatal(err)
	}

	id, _ := age.GenerateX25519Identity()
	s3 := &fakeS3{objs: map[string][]byte{}}
	srv := httptest.NewServer(s3)
	defer srv.Close()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	e.s.cfg.BackupKeep = 2
	e.s.cfg.S3 = S3Config{Endpoint: srv.URL, Bucket: "bucket", AccessKey: "key", SecretKey: "secret"}

	ctx := context.Background()
	day := time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)
	run := func(at time.Time) {
		t.Helper()
		if err := e.s.backup(ctx, at); err != nil {
			t.Fatal(err)
		}
		if err := e.s.syncS3(ctx); err != nil {
			t.Fatal(err)
		}
	}
	run(day)
	run(day.Add(time.Hour)) // not due yet: no second snapshot

	names, _ := e.s.snapshots()
	if len(names) != 1 || names[0] != "thread-20261001T030000Z.db.age" {
		t.Fatalf("snapshots = %v", names)
	}
	if got := s3.keys("media/"); len(got) != 1 || got[0] != "media/"+attached {
		t.Fatalf("uploaded media = %v (loose upload %s must wait)", got, loose)
	}
	if got := s3.keys("db/"); len(got) != 1 {
		t.Fatalf("uploaded snapshots = %v", got)
	}

	// The snapshot opens with the owner's key and holds the real data.
	f, _ := os.Open(filepath.Join(e.s.backupDir(), names[0]))
	defer f.Close()
	r, err := age.Decrypt(f, id)
	if err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(t.TempDir(), "restored.db")
	out, _ := os.Create(plain)
	if _, err := io.Copy(out, r); err != nil {
		t.Fatal(err)
	}
	out.Close()
	db, err := sql.Open("sqlite", plain)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var who string
	if err := db.QueryRow(`SELECT name FROM users`).Scan(&who); err != nil || who != "A" {
		t.Fatalf("restored users: %q %v", who, err)
	}
	if _, err := os.Stat(filepath.Join(e.s.backupDir(), ".snapshot.db")); !os.IsNotExist(err) {
		t.Fatal("plaintext snapshot left on disk")
	}

	// A day later: a new snapshot, the oldest beyond BackupKeep is pruned,
	// only the new one is uploaded.
	run(day.Add(25 * time.Hour))
	run(day.Add(50 * time.Hour))
	if names, _ = e.s.snapshots(); len(names) != 2 || names[0] != "thread-20261002T040000Z.db.age" {
		t.Fatalf("after prune = %v", names)
	}
	if got := s3.keys("db/"); len(got) != 3 {
		t.Fatalf("uploaded snapshots = %v", got)
	}
}

func TestBackupRefusesBadConfig(t *testing.T) {
	for _, cfg := range []Config{
		{BackupTo: "not-a-key"},
		{S3: S3Config{Endpoint: "https://s3.example", Bucket: "b"}}, // S3 without a key to encrypt to
	} {
		cfg.DataDir = t.TempDir()
		cfg.VAPIDSubject = "mailto:t@example.com"
		if s, err := New(context.Background(), cfg, nil); err == nil {
			s.Close()
			t.Fatalf("New(%+v) accepted", cfg)
		}
	}
}
