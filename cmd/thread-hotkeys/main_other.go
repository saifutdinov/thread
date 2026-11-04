//go:build !windows

package main

import "os"

// The browser shortcut works on every supported desktop platform. The
// native backend needs a platform implementation and device validation.
func main() { os.Exit(2) }
