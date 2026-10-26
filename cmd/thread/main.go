// Command thread runs the Thread (Нитка) chat server.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/saifutdinov/thread/internal/server"
)

// version is the release, set by the Dockerfile (-X main.version).
var version = "dev"

func main() {
	// "thread healthcheck" is the container healthcheck: distroless has no curl.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		resp, err := http.Get("http://127.0.0.1" + env("ADDR", ":8080") + "/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg := server.Config{
		Version:    version,
		Addr:       env("ADDR", ":8080"),
		DataDir:    env("DATA_DIR", "./data"),
		StaticDir:  env("STATIC_DIR", "./web/dist"),
		BaseURL:    strings.TrimRight(env("BASE_URL", "http://localhost:8080"), "/"),
		TrustProxy: os.Getenv("TRUST_PROXY") == "1",
	}
	cfg.CookieSecure = strings.HasPrefix(cfg.BaseURL, "https://")
	cfg.VAPIDSubject = env("VAPID_SUBJECT", cfg.BaseURL)
	cfg.TurnSecret = os.Getenv("TURN_SECRET")
	for _, u := range strings.Split(os.Getenv("TURN_URLS"), ",") {
		if u = strings.TrimSpace(u); u != "" {
			cfg.TurnURLs = append(cfg.TurnURLs, u)
		}
	}
	cfg.MetricsAddr = os.Getenv("METRICS_ADDR")
	cfg.BackupTo = os.Getenv("BACKUP_RECIPIENT")
	keep, err := strconv.Atoi(env("BACKUP_KEEP", "7"))
	if err != nil || keep < 1 {
		return errors.New("BACKUP_KEEP must be a positive number")
	}
	cfg.BackupKeep = keep
	cfg.S3 = server.S3Config{
		Endpoint:  os.Getenv("BACKUP_S3_ENDPOINT"),
		Region:    os.Getenv("BACKUP_S3_REGION"),
		Bucket:    os.Getenv("BACKUP_S3_BUCKET"),
		AccessKey: os.Getenv("BACKUP_S3_ACCESS_KEY"),
		SecretKey: os.Getenv("BACKUP_S3_SECRET_KEY"),
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return err
	}
	pepper, err := loadPepper(cfg.DataDir, log)
	if err != nil {
		return err
	}
	cfg.Pepper = pepper

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv, err := server.New(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer srv.Close()
	return srv.Run(ctx)
}

// loadPepper reads PASSWORD_PEPPER (base64, >= 32 bytes). Without it a
// pepper is generated into the data dir, which is fine for development but
// means a stolen data volume carries its own pepper.
func loadPepper(dataDir string, log *slog.Logger) ([]byte, error) {
	if v := os.Getenv("PASSWORD_PEPPER"); v != "" {
		p, err := base64.StdEncoding.DecodeString(v)
		if err != nil || len(p) < 32 {
			return nil, errors.New("PASSWORD_PEPPER must be base64 of at least 32 bytes")
		}
		return p, nil
	}
	path := filepath.Join(dataDir, "pepper")
	if p, err := os.ReadFile(path); err == nil {
		log.Warn("PASSWORD_PEPPER not set, using the generated one from the data dir")
		return p, nil
	}
	p := make([]byte, 32)
	rand.Read(p)
	if err := os.WriteFile(path, p, 0o600); err != nil {
		return nil, fmt.Errorf("write pepper: %w", err)
	}
	log.Warn("PASSWORD_PEPPER not set, generated one into the data dir")
	return p, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
