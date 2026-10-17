package server

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
)

// Metrics for Prometheus, served on a separate internal port
// (METRICS_ADDR) that nginx never proxies. A handful of counters in the
// text format by hand: not worth client_golang.

type metrics struct {
	responses [6]atomic.Int64 // by status class, index 1..5
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets the WebSocket upgrade reach the Hijacker underneath.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) count(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		if sw.code == 0 {
			sw.code = http.StatusOK
		}
		if c := sw.code / 100; c >= 1 && c <= 5 {
			s.m.responses[c].Add(1)
		}
	})
}

func (s *Server) metricsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b strings.Builder
		b.WriteString("# TYPE thread_http_responses_total counter\n")
		for c := 1; c <= 5; c++ {
			fmt.Fprintf(&b, "thread_http_responses_total{code=\"%dxx\"} %d\n", c, s.m.responses[c].Load())
		}
		fmt.Fprintf(&b, "# TYPE thread_push_total counter\n"+
			"thread_push_total{result=\"sent\"} %d\nthread_push_total{result=\"expired\"} %d\nthread_push_total{result=\"failed\"} %d\n",
			s.push.sent.Load(), s.push.expired.Load(), s.push.failed.Load())
		fmt.Fprintf(&b, "# TYPE thread_sockets gauge\nthread_sockets %d\n", s.hub.count())

		// Only when configured, so "no backup for a day" cannot fire on a
		// server that was never meant to back up.
		stamps := map[string]string{}
		if len(s.backupTo) > 0 {
			stamps["backup_at"] = "thread_backup_last_success_timestamp_seconds"
		}
		if s.cfg.S3.enabled() {
			stamps["backup_s3_at"] = "thread_backup_upload_last_success_timestamp_seconds"
		}
		for k, name := range stamps {
			v, err := metaGet(r.Context(), s.db, k)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			n, _ := strconv.ParseInt(v, 10, 64)
			fmt.Fprintf(&b, "# TYPE %s gauge\n%s %d\n", name, name, n)
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		w.Write([]byte(b.String()))
	})
}
