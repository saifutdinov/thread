//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var registrationPaths = []string{`Software\Google\Chrome\NativeMessagingHosts\ru.thread.hotkeys`, `Software\Microsoft\Edge\NativeMessagingHosts\ru.thread.hotkeys`}

func install(extension string) error {
	base, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	return installAt(extension, filepath.Join(base, "ThreadHotkeys"), registrationPaths)
}

func installAt(extension, dir string, paths []string) error {
	if !regexp.MustCompile(`^[a-p]{32}$`).MatchString(extension) {
		return errors.New("invalid_extension_id")
	}
	manifest := filepath.Join(dir, "ru.thread.hotkeys.json")
	for _, path := range paths {
		key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
		if err == nil {
			previous, _, readErr := key.GetStringValue("")
			_ = key.Close()
			if readErr != nil || previous != manifest {
				return errors.New("another_host_is_registered")
			}
		} else if !errors.Is(err, registry.ErrNotExist) {
			return err
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	target := filepath.Join(dir, "thread-hotkeys.exe")
	if filepath.Clean(exe) != filepath.Clean(target) {
		data, err := os.ReadFile(exe)
		if err != nil {
			return err
		}
		stage := target + ".new"
		defer func() { _ = os.Remove(stage) }()
		if err := os.WriteFile(stage, data, 0o700); err != nil {
			return err
		}
		if err := os.Rename(stage, target); err != nil {
			return err
		}
	}
	info := map[string]any{"name": "ru.thread.hotkeys", "description": "Thread push-to-talk", "path": target, "type": "stdio", "allowed_origins": []string{"chrome-extension://" + extension + "/"}}
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(manifest, data, 0o600); err != nil {
		return err
	}
	for _, path := range paths {
		key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
		if err != nil {
			return err
		}
		err = key.SetStringValue("", manifest)
		_ = key.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func uninstall() error {
	base, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	return uninstallAt(filepath.Join(base, "ThreadHotkeys"), registrationPaths)
}

func uninstallAt(dir string, paths []string) error {
	manifest := filepath.Join(dir, "ru.thread.hotkeys.json")
	var owned []string
	// Check every registration before changing any. Never remove another host.
	for _, path := range paths {
		key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		value, _, err := key.GetStringValue("")
		_ = key.Close()
		if err != nil || value != manifest {
			return errors.New("another_host_is_registered")
		}
		owned = append(owned, path)
	}
	for _, path := range owned {
		if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil {
			return err
		}
	}
	// Only the two files created by install; never recursively delete this directory.
	for _, file := range []string{manifest, filepath.Join(dir, "thread-hotkeys.exe")} {
		exe, _ := os.Executable()
		if filepath.Clean(file) == filepath.Clean(exe) {
			continue
		} // Windows locks the running executable
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func installationResult(err error, removing bool) {
	lang, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage").Call()
	ru := lang&0x3ff == 0x19
	text := "Companion installed for this Windows user. Reload Thread."
	if ru {
		text = "Компаньон установлен для этого пользователя Windows. Обновите страницу Нитки."
	}
	if removing {
		text = "Companion unregistered. You can delete the ThreadHotkeys folder."
		if ru {
			text = "Компаньон отключён. Каталог ThreadHotkeys можно удалить."
		}
	}
	if err != nil {
		text = "Installation failed: " + err.Error()
		if ru {
			text = "Установка не выполнена: " + err.Error()
		}
		if removing {
			text = "Uninstall failed: " + err.Error()
			if ru {
				text = "Удаление не выполнено: " + err.Error()
			}
		}
	}
	_, _, _ = user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(text))), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Thread"))), 0)
}
