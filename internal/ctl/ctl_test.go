package ctl

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSocketPathIsSeparatePerChannel(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	stable, err := SocketPath("")
	if err != nil {
		t.Fatal(err)
	}
	nightly, err := SocketPath("-nightly")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(stable) == filepath.Dir(nightly) {
		t.Fatalf("stable and nightly share the directory %s", filepath.Dir(stable))
	}
	if base := filepath.Base(filepath.Dir(nightly)); !strings.HasPrefix(base, "shijimi-nightly-") {
		t.Fatalf("nightly dir = %s", base)
	}
	if base := filepath.Base(filepath.Dir(stable)); !strings.HasPrefix(base, "shijimi-") || strings.Contains(base, "nightly") {
		t.Fatalf("stable dir = %s", base)
	}
}
