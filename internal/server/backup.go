package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
)

// Backups: once a day the database is snapshotted (VACUUM INTO) and
// encrypted with age to the owner's public key, so the server can write
// backups but never read them back. Snapshots are kept in DATA_DIR/backups;
// with S3 configured, every hour the snapshots not yet uploaded and the
// media files not yet uploaded go to the bucket. Media files are already
// end-to-end encrypted, they are uploaded as they are.
//
// Restore needs only the stock age CLI (scripts/README.md, Backups).

const backupEvery = 24 * time.Hour

// S3Config is any S3-compatible bucket (AWS, MinIO and the like), path-style.
type S3Config struct {
	Endpoint  string // https://s3.example.com
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
}

func (c S3Config) enabled() bool { return c.Endpoint != "" && c.Bucket != "" }

func parseRecipients(list string) ([]age.Recipient, error) {
	if strings.TrimSpace(list) == "" {
		return nil, nil
	}
	return age.ParseRecipients(strings.NewReader(strings.ReplaceAll(list, ",", "\n")))
}

func (s *Server) backupDir() string { return filepath.Join(s.cfg.DataDir, "backups") }

func (s *Server) backupLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := s.backup(ctx, time.Now()); err != nil {
			s.log.Error("backup", "err", err)
		}
		if s.cfg.S3.enabled() {
			if err := s.syncS3(ctx); err != nil {
				s.log.Error("backup upload", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// backup writes an encrypted snapshot when the last one is a day old.
func (s *Server) backup(ctx context.Context, at time.Time) error {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()
	if err := s.cleanBackupStaging(); err != nil {
		return err
	}
	last, err := metaGet(ctx, s.db, "backup_at")
	if err != nil {
		return err
	}
	if n, _ := strconv.ParseInt(last, 10, 64); at.Sub(time.Unix(n, 0)) < backupEvery {
		// Upgrade an old snapshot without pinned media immediately. It cannot
		// be made complete later using only the public age recipient key.
		names, err := s.snapshots()
		if err != nil {
			return err
		}
		if len(names) > 0 {
			if _, err := os.Stat(filepath.Join(s.backupDir(), names[len(names)-1]+".media", "manifest.json")); err == nil {
				return nil
			}
		}
	}
	dir := s.backupDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	plain := filepath.Join(dir, ".snapshot.db")
	os.Remove(plain) // left over from a crash; VACUUM INTO refuses to overwrite
	defer os.Remove(plain)
	name := "thread-" + at.UTC().Format("20060102T150405Z") + ".db.age"
	stage, err := os.MkdirTemp(dir, ".media-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(stage) }()
	if err := s.snapshotWithMedia(ctx, plain, stage); err != nil {
		return err
	}
	dst := filepath.Join(dir, name)
	pending := dst + ".pending"
	defer os.Remove(pending)
	if err := encryptFile(pending, plain, s.backupTo); err != nil {
		return fmt.Errorf("encrypt snapshot: %w", err)
	}
	// The age file becomes discoverable only after its manifest and hard
	// links are in place. An interrupted encryption/upload is not published.
	if err := os.Rename(stage, dst+".media"); err != nil {
		return err
	}
	if err := os.Rename(pending, dst); err != nil {
		return err
	}
	if err := metaSet(ctx, s.db, "backup_at", strconv.FormatInt(at.Unix(), 10)); err != nil {
		return err
	}
	s.log.Info("backup written", "file", name)
	return s.pruneBackups()
}

type backupManifest struct {
	Version int      `json:"version"`
	Files   []string `json:"files"`
}

// A process crash can leave plaintext or pinned files before publication.
// This also runs when today's complete snapshot needs no replacement.
func (s *Server) cleanBackupStaging() error {
	entries, err := os.ReadDir(s.backupDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		staging := name == ".snapshot.db" || strings.HasPrefix(name, ".media-") ||
			(strings.HasPrefix(name, "thread-") && (strings.HasSuffix(name, ".db.age.pending") || strings.HasSuffix(name, ".db.age.pending.part")))
		if strings.HasPrefix(name, "thread-") && strings.HasSuffix(name, ".db.age.media") {
			_, err := os.Stat(filepath.Join(s.backupDir(), strings.TrimSuffix(name, ".media")))
			if errors.Is(err, os.ErrNotExist) {
				staging = true
			} else if err != nil {
				return err
			}
		}
		if staging {
			if err := os.RemoveAll(filepath.Join(s.backupDir(), name)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) snapshotWithMedia(ctx context.Context, plain, stage string) error {
	s.mediaMu.Lock()
	defer s.mediaMu.Unlock()
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, plain); err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(plain)+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `SELECT id FROM media WHERE message_id IS NOT NULL ORDER BY id`)
	if err != nil {
		return err
	}
	ids, err := scanStrings(rows)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !validMediaID(id) {
			return fmt.Errorf("snapshot: invalid media id")
		}
		if err := os.Link(s.mediaPath(id), filepath.Join(stage, id)); err != nil {
			return fmt.Errorf("pin snapshot media %s: %w", id, err)
		}
	}
	manifest, err := json.Marshal(backupManifest{Version: 1, Files: ids})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stage, "manifest.json"), manifest, 0o600)
}

func encryptFile(dst, src string, to []age.Recipient) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	part := dst + ".part"
	out, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(part) // no-op after the rename
	w, err := age.Encrypt(out, to...)
	if err == nil {
		_, err = io.Copy(w, in)
	}
	if err == nil {
		err = w.Close()
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(part, dst)
}

// snapshots lists the encrypted snapshots, oldest first (names sort by time).
func (s *Server) snapshots() ([]string, error) {
	names, err := filepath.Glob(filepath.Join(s.backupDir(), "thread-*.db.age"))
	for i, n := range names {
		names[i] = filepath.Base(n)
	}
	sort.Strings(names)
	return names, err
}

// pruneBackups runs only after a new snapshot succeeded, so a broken run
// never eats the history behind it.
func (s *Server) pruneBackups() error {
	names, err := s.snapshots()
	if err != nil {
		return err
	}
	for len(names) > max(s.cfg.BackupKeep, 1) {
		if err := os.Remove(filepath.Join(s.backupDir(), names[0])); err != nil {
			return err
		}
		if err := os.RemoveAll(filepath.Join(s.backupDir(), names[0]+".media")); err != nil {
			return err
		}
		names = names[1:]
	}
	return nil
}

// syncS3 uploads what the bucket does not have yet: newer snapshots
// (tracked by the last uploaded name) and media rows not marked backed_up.
// Old snapshots in the bucket expire by a lifecycle rule, not from here.
func (s *Server) syncS3(ctx context.Context) error {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()
	done, err := metaGet(ctx, s.db, "backup_s3_db")
	if err != nil {
		return err
	}
	names, err := s.snapshots()
	if err != nil {
		return err
	}
	for _, n := range names {
		if n <= done {
			continue
		}
		pins := filepath.Join(s.backupDir(), n+".media")
		bytes, err := os.ReadFile(filepath.Join(pins, "manifest.json"))
		if errors.Is(err, os.ErrNotExist) {
			s.log.Warn("legacy snapshot has no pinned media, keeping local", "file", n)
			continue
		}
		if err != nil {
			return err
		}
		var manifest backupManifest
		if err := json.Unmarshal(bytes, &manifest); err != nil || manifest.Version != 1 {
			return fmt.Errorf("invalid backup manifest for %s", n)
		}
		for _, id := range manifest.Files {
			if !validMediaID(id) {
				return fmt.Errorf("invalid backup media id")
			}
			var backed bool
			if err := s.db.QueryRowContext(ctx, `SELECT backed_up FROM media WHERE id = ?`, id).Scan(&backed); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if backed {
				continue
			}
			if err := s.s3Put(ctx, "media/"+id, filepath.Join(pins, id)); err != nil {
				return err
			}
			if _, err := s.db.ExecContext(ctx, `UPDATE media SET backed_up = 1 WHERE id = ?`, id); err != nil {
				return err
			}
		}
		if err := s.s3Put(ctx, "db/"+n, filepath.Join(s.backupDir(), n)); err != nil {
			return err
		}
		// Published last: restore tools can distinguish a complete snapshot
		// from an age file whose upload was interrupted or lost its media.
		if err := s.s3Put(ctx, "db/"+n+".manifest.json", filepath.Join(pins, "manifest.json")); err != nil {
			return err
		}
		if err := metaSet(ctx, s.db, "backup_s3_db", n); err != nil {
			return err
		}
	}
	// Uploads not yet attached to a message are skipped: most get attached
	// within seconds, the rest are deleted by cleanup.
	ids, err := s.mediaIDs(ctx, `SELECT id FROM media WHERE backed_up = 0 AND message_id IS NOT NULL`)
	if err != nil {
		return err
	}
	for _, id := range ids {
		err := s.s3Put(ctx, "media/"+id, s.mediaPath(id))
		if errors.Is(err, os.ErrNotExist) {
			continue // deleted meanwhile
		}
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE media SET backed_up = 1 WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return metaSet(ctx, s.db, "backup_s3_at", strconv.FormatInt(time.Now().Unix(), 10))
}

var s3Client = &http.Client{Timeout: 15 * time.Minute}

func (s *Server) s3Put(ctx context.Context, key, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	c := s.cfg.S3
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimRight(c.Endpoint, "/")+"/"+c.Bucket+"/"+key, f)
	if err != nil {
		return err
	}
	req.ContentLength = n
	req.Header.Set("x-amz-content-sha256", hex.EncodeToString(h.Sum(nil)))
	signV4(req, c, time.Now())
	resp, err := s3Client.Do(req)
	if err != nil {
		return fmt.Errorf("s3 put %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("s3 put %s: %s: %s", key, resp.Status, body)
	}
	return nil
}

// signV4 adds an AWS Signature V4 Authorization header covering host and
// every header already set (x-amz-content-sha256 must be among them).
// Limit: no query-string canonicalization, PUT/GET of plain keys only.
func signV4(r *http.Request, c S3Config, at time.Time) {
	stamp := at.UTC().Format("20060102T150405Z")
	day := stamp[:8]
	r.Header.Set("x-amz-date", stamp)

	headers := map[string]string{"host": r.URL.Host}
	for k, v := range r.Header {
		headers[strings.ToLower(k)] = strings.TrimSpace(strings.Join(v, ","))
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	slices.Sort(names)
	var canon strings.Builder
	for _, k := range names {
		canon.WriteString(k + ":" + headers[k] + "\n")
	}
	signed := strings.Join(names, ";")
	req := strings.Join([]string{r.Method, r.URL.EscapedPath(), r.URL.RawQuery, canon.String(), signed,
		r.Header.Get("x-amz-content-sha256")}, "\n")

	region := c.Region
	if region == "" {
		region = "us-east-1"
	}
	scope := day + "/" + region + "/s3/aws4_request"
	sum := sha256.Sum256([]byte(req))
	toSign := "AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	key := []byte("AWS4" + c.SecretKey)
	for _, part := range []string{day, region, "s3", "aws4_request", toSign} {
		m := hmac.New(sha256.New, key)
		m.Write([]byte(part))
		key = m.Sum(nil)
	}
	r.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+c.AccessKey+"/"+scope+
		", SignedHeaders="+signed+", Signature="+hex.EncodeToString(key))
}
