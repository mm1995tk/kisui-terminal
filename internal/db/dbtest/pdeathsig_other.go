//go:build !linux

package dbtest

import "os/exec"

// dieWithParent does nothing where the OS cannot do it.
func dieWithParent(*exec.Cmd) {}
