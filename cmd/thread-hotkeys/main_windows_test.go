//go:build windows

package main

import (
	"os"
	"testing"
	"time"

	"github.com/saifutdinov/thread/internal/hotkeys"
)

// Opt-in because this sends a short Ctrl+Shift+F24 chord to the Windows
// desktop. It does not focus Thread or suppress input in the foreground app.
func TestWindowsGlobalKeyState(t *testing.T) {
	if os.Getenv("THREAD_HOTKEY_INPUT_TEST") != "1" {
		t.Skip("explicit desktop input test")
	}
	event := user32.NewProc("keybd_event")
	for _, key := range []uintptr{0x87, 0x10, 0x11} {
		_, _, _ = event.Call(key, 0, 2, 0)
	}
	defer func() {
		for _, key := range []uintptr{0x87, 0x10, 0x11} {
			_, _, _ = event.Call(key, 0, 2, 0)
		}
	}()
	b := hotkeys.Binding{Code: "F24", Ctrl: true, Shift: true}
	if pressed(b) {
		t.Fatal("released shortcut reported as held")
	}
	for _, key := range []uintptr{0x11, 0x10, 0x87} {
		_, _, _ = event.Call(key, 0, 0, 0)
	}
	time.Sleep(30 * time.Millisecond)
	if !pressed(b) {
		t.Fatal("Windows did not report the system shortcut")
	}
	_, _, _ = event.Call(0x10, 0, 2, 0)
	if pressed(b) {
		t.Fatal("modifier release did not end the shortcut")
	}
}
