//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

func TestInstallRegistersOnlyItsIsolatedHostAndRefusesAnother(t *testing.T) {
	root := fmt.Sprintf(`Software\ThreadHotkeysTest-%d-%d`, os.Getpid(), time.Now().UnixNano())
	paths := []string{root + `\Chrome`, root + `\Edge`}
	t.Cleanup(func() {
		for _, path := range paths {
			_ = registry.DeleteKey(registry.CURRENT_USER, path)
		}
		_ = registry.DeleteKey(registry.CURRENT_USER, root)
	})
	dir := t.TempDir()
	id := "gpllklapodoigknihafpbaikjcndiioe"
	if err := installAt(id, dir, paths); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "ru.thread.hotkeys.json")
	data, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var host struct {
		Path    string   `json:"path"`
		Origins []string `json:"allowed_origins"`
	}
	if err := json.Unmarshal(data, &host); err != nil || len(host.Origins) != 1 || host.Origins[0] != "chrome-extension://"+id+"/" {
		t.Fatalf("manifest: %s, %v", data, err)
	}
	if _, err := os.Stat(host.Path); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
		if err != nil {
			t.Fatal(err)
		}
		value, _, err := key.GetStringValue("")
		if err != nil || value != manifest {
			_ = key.Close()
			t.Fatalf("registration: %s %v", value, err)
		}
		_ = key.Close()
	}
	if err := installAt(id, dir, paths); err != nil {
		t.Fatalf("reinstall: %v", err)
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, paths[0], registry.SET_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	err = key.SetStringValue("", "another-host.json")
	_ = key.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := installAt(id, dir, paths); err == nil || err.Error() != "another_host_is_registered" {
		t.Fatalf("overwrote another registration: %v", err)
	}
	if err := installAt("invalid", dir, paths); err == nil || err.Error() != "invalid_extension_id" {
		t.Fatalf("accepted invalid extension: %v", err)
	}
}

func TestUninstallRemovesOnlyItsExactRegistrationAndFiles(t *testing.T) {
	root := fmt.Sprintf(`Software\ThreadHotkeysUninstallTest-%d-%d`, os.Getpid(), time.Now().UnixNano())
	paths := []string{root + `\Chrome`, root + `\Edge`}
	t.Cleanup(func() {
		for _, path := range paths {
			_ = registry.DeleteKey(registry.CURRENT_USER, path)
		}
		_ = registry.DeleteKey(registry.CURRENT_USER, root)
	})
	dir := t.TempDir()
	if err := installAt("gpllklapodoigknihafpbaikjcndiioe", dir, paths); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(foreign, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, paths[1], registry.SET_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	err = key.SetStringValue("", "another-host.json")
	_ = key.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := uninstallAt(dir, paths); err == nil || err.Error() != "another_host_is_registered" {
		t.Fatalf("foreign registration accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ru.thread.hotkeys.json")); err != nil {
		t.Fatalf("files changed despite foreign registration: %v", err)
	}
	key, err = registry.OpenKey(registry.CURRENT_USER, paths[1], registry.SET_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	err = key.SetStringValue("", filepath.Join(dir, "ru.thread.hotkeys.json"))
	_ = key.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := uninstallAt(dir, paths); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
		if err == nil {
			_ = key.Close()
			t.Fatal("registration retained")
		}
		if err != registry.ErrNotExist {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"ru.thread.hotkeys.json", "thread-hotkeys.exe"} {
		if _, err := os.Stat(filepath.Join(dir, file)); !os.IsNotExist(err) {
			t.Fatalf("installed file retained: %s %v", file, err)
		}
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatalf("unrelated file removed: %v", err)
	}
	if err := uninstallAt(dir, paths); err != nil {
		t.Fatalf("repeat uninstall: %v", err)
	}
}
