//go:build windows

// Command thread-hotkeys is launched only by the browser's native-messaging bridge.
package main

import (
	"os"
	"strconv"

	"github.com/saifutdinov/thread/internal/hotkeys"
	"golang.org/x/sys/windows"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var asyncKey = user32.NewProc("GetAsyncKeyState")
var foreground = user32.NewProc("GetForegroundWindow")
var windowThread = user32.NewProc("GetWindowThreadProcessId")
var keyboardLayout = user32.NewProc("GetKeyboardLayout")
var mapKey = user32.NewProc("MapVirtualKeyExW")

var scans = map[string]uintptr{
	"KeyA": 0x1e, "KeyB": 0x30, "KeyC": 0x2e, "KeyD": 0x20, "KeyE": 0x12, "KeyF": 0x21, "KeyG": 0x22,
	"KeyH": 0x23, "KeyI": 0x17, "KeyJ": 0x24, "KeyK": 0x25, "KeyL": 0x26, "KeyM": 0x32, "KeyN": 0x31,
	"KeyO": 0x18, "KeyP": 0x19, "KeyQ": 0x10, "KeyR": 0x13, "KeyS": 0x1f, "KeyT": 0x14, "KeyU": 0x16,
	"KeyV": 0x2f, "KeyW": 0x11, "KeyX": 0x2d, "KeyY": 0x15, "KeyZ": 0x2c,
	"Digit0": 0x0b, "Digit1": 0x02, "Digit2": 0x03, "Digit3": 0x04, "Digit4": 0x05, "Digit5": 0x06,
	"Digit6": 0x07, "Digit7": 0x08, "Digit8": 0x09, "Digit9": 0x0a,
	"Backquote": 0x29, "Minus": 0x0c, "Equal": 0x0d, "BracketLeft": 0x1a, "BracketRight": 0x1b,
	"Backslash": 0x2b, "Semicolon": 0x27, "Quote": 0x28, "Comma": 0x33, "Period": 0x34, "Slash": 0x35,
}

func down(vk uintptr) bool { n, _, _ := asyncKey.Call(vk); return n&0x8000 != 0 }

var keys = map[string]uintptr{
	"Space": 0x20, "Tab": 0x09, "Enter": 0x0D, "Backspace": 0x08, "Backquote": 0xC0,
	"Minus": 0xBD, "Equal": 0xBB, "BracketLeft": 0xDB, "BracketRight": 0xDD, "Backslash": 0xDC,
	"Semicolon": 0xBA, "Quote": 0xDE, "Comma": 0xBC, "Period": 0xBE, "Slash": 0xBF,
	"ArrowUp": 0x26, "ArrowDown": 0x28, "ArrowLeft": 0x25, "ArrowRight": 0x27,
	"Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22, "Insert": 0x2D, "Delete": 0x2E,
}

func pressed(b hotkeys.Binding) bool {
	if b.Ctrl != down(0x11) || b.Alt != down(0x12) || b.Shift != down(0x10) || b.Meta != (down(0x5B) || down(0x5C)) {
		return false
	}
	vk := keys[b.Code]
	if scan := scans[b.Code]; scan != 0 {
		// Match KeyboardEvent.code's physical position in the foreground
		// application's layout, including non-QWERTY layouts.
		hwnd, _, _ := foreground.Call()
		thread, _, _ := windowThread.Call(hwnd, 0)
		layout, _, _ := keyboardLayout.Call(thread)
		vk, _, _ = mapKey.Call(scan, 3, layout)
	}
	if len(b.Code) > 1 && b.Code[0] == 'F' {
		n, _ := strconv.Atoi(b.Code[1:])
		vk = uintptr(0x70 + n - 1)
	}
	return vk != 0 && down(vk)
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "install" {
		id := ""
		if len(os.Args) == 3 {
			id = os.Args[2]
		}
		err := install(id)
		installationResult(err, false)
		if err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "uninstall" {
		err := uninstall()
		installationResult(err, true)
		if err != nil {
			os.Exit(1)
		}
		return
	}
	if hotkeys.Run(os.Stdin, os.Stdout, pressed) != nil {
		os.Exit(1)
	}
}
