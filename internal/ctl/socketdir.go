package ctl

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// What CheckSocketDir found wrong with a directory (SocketDirError.Problem).
const (
	// SocketDirSymlink: the path is a symbolic link.
	SocketDirSymlink = "symlink"
	// SocketDirNotDir: the path is something else than a directory.
	SocketDirNotDir = "not-dir"
	// SocketDirOwner: the directory belongs to another user (Owner).
	SocketDirOwner = "owner"
	// SocketDirMode: the permission of the directory (Mode) is not 0700.
	SocketDirMode = "mode"
)

// SocketDirError says why Dir is not used as the socket directory. Its text is
// for the user, in the language of the settings (internal/i18n).
type SocketDirError struct {
	Dir     string
	Problem string      // one of the SocketDir* constants
	Owner   uint32      // SocketDirOwner: the uid the directory belongs to
	Mode    fs.FileMode // SocketDirMode: its permission
}

func (e *SocketDirError) Error() string {
	switch e.Problem {
	case SocketDirSymlink:
		return fmt.Sprintf(i18n.T("socketdir.symlink"), e.Dir)
	case SocketDirOwner:
		return fmt.Sprintf(i18n.T("socketdir.owner"), e.Dir, e.Owner, os.Getuid())
	case SocketDirMode:
		return fmt.Sprintf(i18n.T("socketdir.mode"), e.Dir, uint32(e.Mode.Perm()))
	}
	return fmt.Sprintf(i18n.T("socketdir.notdir"), e.Dir)
}

// CheckSocketDir checks that dir can hold the sockets of this user: it is a
// directory itself (not a symbolic link to one), it belongs to this user, and
// its permission is 0700, so that no other user can put a socket there or
// reach one. It changes nothing: a directory that does not pass is not used,
// and the *SocketDirError says why. A directory that is not there is the error
// of os.Lstat (fs.ErrNotExist).
//
// Call it before listening on, or connecting to, a socket in a directory that
// this process did not get from SocketDir with create.
func CheckSocketDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return &SocketDirError{Dir: dir, Problem: SocketDirSymlink}
	}
	if !fi.IsDir() {
		return &SocketDirError{Dir: dir, Problem: SocketDirNotDir}
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: unknown owner", dir)
	}
	if st.Uid != uint32(os.Getuid()) {
		return &SocketDirError{Dir: dir, Problem: SocketDirOwner, Owner: st.Uid}
	}
	if perm := fi.Mode().Perm(); perm != 0o700 {
		return &SocketDirError{Dir: dir, Problem: SocketDirMode, Mode: perm}
	}
	return nil
}
