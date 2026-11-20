package db

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// keychainTimeout is how long the keychain may take to answer. It is long
// because macOS can ask the user whether to allow the read.
const keychainTimeout = 30 * time.Second

// keychainPassword reads the generic password of the service KeychainService
// and the account name with /usr/bin/security, which is part of macOS (so no
// library and no cgo). ok is false when there is no such item, and also when
// the keychain cannot be read (it is locked in a login over ssh): the caller
// then goes on to the next place.
//
// security prints a password that has characters outside ASCII as
// hexadecimal digits, so such a password does not work from the keychain.
func keychainPassword(ctx context.Context, name string) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, keychainTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-s", KeychainService, "-a", name, "-w").Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSuffix(string(out), "\n"), true
}
