package server

import (
	"fmt"
	"io"
	"net/http"
	"testing"
)

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestEncryptedUploadBoundary(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, _ := a.createChat("group", 1)
	// 50 MiB plaintext + 12-byte IV + 16-byte GCM tag. Stream test
	// bodies instead of retaining three large byte slices in memory.
	for _, size := range []int64{maxUpload - 1, maxUpload, maxUpload + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			req, err := http.NewRequest("POST", e.ts.URL+"/api/media?chat="+itoa(chat), io.LimitReader(zeroReader{}, size))
			if err != nil {
				t.Fatal(err)
			}
			req.ContentLength = size
			resp, err := a.hc.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			want := http.StatusOK
			if size > maxUpload {
				want = http.StatusRequestEntityTooLarge
			}
			if resp.StatusCode != want {
				t.Fatalf("size=%d status=%d want=%d", size, resp.StatusCode, want)
			}
		})
	}
}
