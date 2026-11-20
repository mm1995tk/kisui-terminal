//go:build !darwin

package db

import "context"

// keychainPassword finds nothing outside macOS. The Secret Service of a Linux
// desktop is not used: the Linux machines kisui serve runs on are mostly ones
// reached over ssh, where there is no session bus to ask.
func keychainPassword(context.Context, string, string) (string, bool) { return "", false }
