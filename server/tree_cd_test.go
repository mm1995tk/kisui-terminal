package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

func TestShellQuote(t *testing.T) {
	if got := shellQuote("/a b/it's"); got != `'/a b/it'\''s'` {
		t.Errorf("got %s", got)
	}
	p := "/a b"
	if got := string(cdInput(&p)); got != "\x05\x15cd -- '/a b'\r" {
		t.Errorf("got %q", got)
	}
	if got := string(cdInput(nil)); got != "\x05\x15cd ..\r" {
		t.Errorf("got %q", got)
	}
}

// term.cd はシェルに cd を打つ。空白や ' を含むパスでも 1 語になる。
func TestTermCdMovesShell(t *testing.T) {
	root := normalizePath(t.TempDir())
	_, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	c, nt := termClient(t, sock)
	_, primary := createWS(t, c)
	dir := filepath.Join(root, "it's a dir")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := call(t, c, "term.cd", map[string]any{"termId": primary, "path": dir}, nil); err != nil {
		t.Fatal(err)
	}
	call(t, c, "term.input", map[string]any{"termId": primary, "data": b64("pwd\n")}, nil)
	waitFor(t, "shell is in the folder", func() bool {
		out, _ := nt.output(t, primary)
		return strings.Contains(string(out), dir+"\r\n")
	})
}

// シェルでないプログラムが前面にいるときは、何も打たずに busy（running）で断る。
func TestTermCdBusyWhenProgramRuns(t *testing.T) {
	srv, sock := startFast(t)
	c, _ := termClient(t, sock)
	_, primary := createWS(t, c)
	call(t, c, "term.input", map[string]any{"termId": primary, "data": b64("sleep 60\n")}, nil)
	tm, _ := srv.terms.get(primary)
	waitFor(t, "program running", tm.busy)
	err := c.Call(context.Background(), "term.cd", map[string]any{"termId": primary, "path": "/"}, nil)
	if !isCode(err, rpc.CodeBusy) {
		t.Fatalf("err = %v", err)
	}
	var d struct{ Reason string }
	json.Unmarshal(err.(*rpc.Error).Data, &d)
	if d.Reason != "running" {
		t.Errorf("data %s", err.(*rpc.Error).Data)
	}
}

func TestHasControlChar(t *testing.T) {
	for _, bad := range []string{"a\x15touch ~/pwned\r", "a\x03", "a\x1b[A", "a\x7f", "a\u0085b"} {
		if !hasControlChar(bad) {
			t.Errorf("%q must be refused", bad)
		}
	}
	for _, ok := range []string{"/a b/it's", "/日本語/フォルダ"} {
		if hasControlChar(ok) {
			t.Errorf("%q must be allowed", ok)
		}
	}
}
