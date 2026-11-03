package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"filippo.io/age"
)

func TestBackupPinsAttachmentDeletedBeforeUpload(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	media := a.upload(chat, []byte("sealed photo"))
	var message struct {
		ID int64 `json:"id"`
	}
	a.must(200, "POST", "/api/chats/"+itoa(chat)+"/messages", map[string]any{"cid": "attached", "epoch": 1, "body": []byte("sealed file key"), "sig": randomBytes(64), "media": []string{media}}, &message)
	id, _ := age.GenerateX25519Identity()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	s3 := &fakeS3{objs: map[string][]byte{}}
	srv := httptest.NewServer(s3)
	defer srv.Close()
	e.s.cfg.S3 = S3Config{Endpoint: srv.URL, Bucket: "bucket", AccessKey: "key", SecretKey: "secret"}
	ctx := context.Background()
	if err := e.s.backup(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	a.must(200, "DELETE", "/api/messages/"+itoa(message.ID), nil, nil)
	if _, err := os.Stat(e.s.mediaPath(media)); !os.IsNotExist(err) {
		t.Fatal("live media was not deleted")
	}
	if err := e.s.syncS3(ctx); err != nil {
		t.Fatal(err)
	}
	s3.mu.Lock()
	defer s3.mu.Unlock()
	if string(s3.objs["media/"+media]) != "sealed photo" {
		t.Fatal("snapshot lost its deleted attachment")
	}
	for key, bytes := range s3.objs {
		if strings.HasSuffix(key, ".manifest.json") {
			var m backupManifest
			if json.Unmarshal(bytes, &m) != nil || len(m.Files) != 1 || m.Files[0] != media {
				t.Fatalf("manifest: %s", bytes)
			}
		}
	}
	// Restore from exactly the S3 objects, rather than the live media table.
	names, _ := e.s.snapshots()
	reader, err := age.Decrypt(bytes.NewReader(s3.objs["db/"+names[0]]), id)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "restored.db")
	if err := os.WriteFile(path, plain, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var restored string
	if err := db.QueryRow(`SELECT id FROM media WHERE message_id = ?`, message.ID).Scan(&restored); err != nil || restored != media {
		t.Fatalf("restored attachment = %q: %v", restored, err)
	}
}

func TestBackupDoesNotPublishIncompleteS3Snapshot(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	media := a.upload(chat, []byte("sealed photo"))
	if _, err := e.s.db.Exec(`UPDATE media SET message_id = 1 WHERE id = ?`, media); err != nil {
		t.Fatal(err)
	}
	id, _ := age.GenerateX25519Identity()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	s3 := &fakeS3{objs: map[string][]byte{}}
	var fail atomic.Bool
	fail.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() && strings.Contains(r.URL.Path, "/media/") {
			w.WriteHeader(503)
			return
		}
		s3.ServeHTTP(w, r)
	}))
	defer srv.Close()
	e.s.cfg.S3 = S3Config{Endpoint: srv.URL, Bucket: "bucket", AccessKey: "key", SecretKey: "secret"}
	ctx := context.Background()
	if err := e.s.backup(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := e.s.syncS3(ctx); err == nil {
		t.Fatal("failed media upload reported success")
	}
	if len(s3.keys("db/")) != 0 {
		t.Fatal("published an incomplete database snapshot")
	}
	fail.Store(false)
	if err := e.s.syncS3(ctx); err != nil {
		t.Fatal(err)
	}
	if len(s3.keys("db/")) != 2 || len(s3.keys("media/")) != 1 {
		t.Fatal("retry did not complete the snapshot")
	}
}

func TestBackupPinsFollowSnapshotRetention(t *testing.T) {
	e := newEnv(t)
	id, _ := age.GenerateX25519Identity()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	e.s.cfg.BackupKeep = 1
	day := time.Now()
	if err := e.s.backup(context.Background(), day); err != nil {
		t.Fatal(err)
	}
	names, _ := e.s.snapshots()
	oldPins := filepath.Join(e.s.backupDir(), names[0]+".media")
	if err := e.s.backup(context.Background(), day.Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPins); !os.IsNotExist(err) {
		t.Fatal("pruned snapshot retained its media pins")
	}
}

func TestBackupCleansCrashStagingEvenWhenSnapshotIsRecent(t *testing.T) {
	e := newEnv(t)
	id, _ := age.GenerateX25519Identity()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	day := time.Now()
	if err := e.s.backup(context.Background(), day); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".snapshot.db", "thread-crash.db.age.pending", "thread-crash.db.age.pending.part", ".media-crash", "thread-crash.db.age.media"} {
		path := filepath.Join(e.s.backupDir(), name)
		if err := os.WriteFile(path, []byte("incomplete"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.s.backup(context.Background(), day.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(e.s.backupDir())
	if err != nil || len(entries) != 2 {
		t.Fatalf("left incomplete files: %v %v", entries, err)
	}
}

func TestBackupUpgradesLegacySnapshotBeforeNextDay(t *testing.T) {
	e := newEnv(t)
	e.s.cfg.BackupKeep = 2
	id, _ := age.GenerateX25519Identity()
	e.s.backupTo = []age.Recipient{id.Recipient()}
	day := time.Now()
	if err := e.s.backup(context.Background(), day); err != nil {
		t.Fatal(err)
	}
	names, _ := e.s.snapshots()
	if err := os.RemoveAll(filepath.Join(e.s.backupDir(), names[0]+".media")); err != nil {
		t.Fatal(err)
	}
	if err := e.s.backup(context.Background(), day.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	names, _ = e.s.snapshots()
	if len(names) != 2 {
		t.Fatal("upgrade did not replace legacy snapshot promptly")
	}
	if _, err := os.Stat(filepath.Join(e.s.backupDir(), names[1]+".media", "manifest.json")); err != nil {
		t.Fatal(err)
	}
}
