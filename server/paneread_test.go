package server

import (
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// kisui pane read は、名前か id で指したペイン（別のワークスペースのものでも）の画面を字で返す。色は入らず、
// --lines で scrollback を遡る。
func TestPaneCmdRead(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFastAll(t)
	c, _ := termClient(t, sock)
	_, p1 := createWS(t, c)
	_, p2 := createWS(t, c)
	tok1, tok2 := termToken(t, srv, p1), termToken(t, srv, p2)
	do1 := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = p1, tok1
		return paneCmdDo(t, sock, rq)
	}
	do2 := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = p2, tok2
		return paneCmdDo(t, sock, rq)
	}

	// 24 行のペインに 40 行と、色の付いた行（行末に空白）を出す
	script := `i=1; while [ $i -le 40 ]; do echo line$i; i=$((i+1)); done; printf '\033[31mred\033[0m   \n'; sleep 30`
	r := do1(panecmd.Request{Cmd: "split", Dir: "right", Name: "worker", Argv: []string{"/bin/sh", "-c", script}})
	if !r.OK {
		t.Fatalf("split: %+v", r)
	}
	worker := r.ID
	var screen panecmd.Reply
	waitFor(t, "the output on the screen", func() bool {
		screen = do2(panecmd.Request{Cmd: "read", To: "worker"})
		return screen.OK && strings.Contains(screen.Text, "red")
	})
	if screen.ID != worker {
		t.Errorf("the id of the pane read: %q, want %q", screen.ID, worker)
	}
	if !strings.HasSuffix(screen.Text, "line40\nred\n") || strings.Contains(screen.Text, "\x1b") {
		t.Errorf("the screen: %q", screen.Text)
	}
	if strings.Contains(screen.Text, "line1\n") {
		t.Errorf("the screen without --lines has the scrollback: %q", screen.Text)
	}

	// --lines で scrollback を遡る（id でも指せる）
	all := do2(panecmd.Request{Cmd: "read", To: worker, Lines: 100})
	if !all.OK || !strings.HasPrefix(all.Text, "line1\nline2\n") || !strings.HasSuffix(all.Text, "line40\nred\n") {
		t.Errorf("read --lines 100: %+v", all)
	}
	some := do2(panecmd.Request{Cmd: "read", To: worker, Lines: 2})
	if n := strings.Count(some.Text, "\n") - strings.Count(screen.Text, "\n"); !some.OK || n != 2 {
		t.Errorf("read --lines 2 has %d more lines than the screen: %+v", n, some)
	}

	if r := do2(panecmd.Request{Cmd: "read", To: "nobody"}); r.OK || !strings.Contains(r.Error, "no pane") {
		t.Errorf("a name that no pane has: %+v", r)
	}
	if r := do2(panecmd.Request{Cmd: "read", To: "worker", Lines: -1}); r.OK || !strings.Contains(r.Error, "negative") {
		t.Errorf("negative lines: %+v", r)
	}
}

func TestCleanScreenText(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", ""},
		{"\n\n", ""},
		{"$ ls  \nfoo\n\n\n", "$ ls\nfoo\n"},
		{"  a\n\n  b", "  a\n\n  b\n"},
	} {
		if got := cleanScreenText(c.in); got != c.want {
			t.Errorf("cleanScreenText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 画面の状態が追いつかない（feeder が答えない）まま readTimeout が過ぎたら、待たずに断る。
func TestReadScreenTimeout(t *testing.T) {
	defer func(d time.Duration) { readTimeout = d }(readTimeout)
	readTimeout = 50 * time.Millisecond
	m := newTermManager(nil)
	// run を動かさない feed：頼みは溜まるだけで、答えが来ない
	m.terms["t1"] = &terminal{id: "t1", name: "stuck", feed: &screenFeed{wake: make(chan struct{}, 1)}}
	start := time.Now()
	_, id, err := m.readScreen("stuck", 0)
	if err == nil || !strings.Contains(err.Error(), "not ready") || id != "t1" {
		t.Fatalf("readScreen = %q %v, want the error of not ready", id, err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("readScreen waited %v", d)
	}
}
