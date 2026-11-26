package server

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/emulator"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// kisui pane send / keys / close は、名前か id で指したほかのペイン（別のワークスペースのものでも）に効く。
func TestPaneCmdSendKeysClose(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFastAll(t)
	c, nt := termClient(t, sock)
	_, p1 := createWS(t, c)
	ws2, p2 := createWS(t, c)
	tok1, tok2 := termToken(t, srv, p1), termToken(t, srv, p2)
	do1 := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = p1, tok1
		return paneCmdDo(t, sock, rq)
	}
	r := paneCmdDo(t, sock, panecmd.Request{Cmd: "split", Dir: "right", Name: "foo", Argv: []string{"/bin/sh"}, Pane: p2, Token: tok2})
	if !r.OK {
		t.Fatalf("split --name foo: %+v", r)
	}
	foo := r.ID
	out := func() string { d, _ := nt.output(t, foo); return string(d) }
	waitFor(t, "pane.show of the split", func() bool { return len(nt.all("pane.show")) == 1 })
	focusBefore := 1

	// 文字と Enter。別のワークスペースのペインから、名前で指す
	if r := do1(panecmd.Request{Cmd: "send", To: "foo", Text: "echo hi-$((40+2))"}); !r.OK || r.ID != foo {
		t.Fatalf("send: %+v", r)
	}
	waitFor(t, "the output of the sent command", func() bool { return strings.Contains(out(), "hi-42") })
	// id でも指せる。改行は Enter になる
	if r := do1(panecmd.Request{Cmd: "send", To: foo, Text: "echo a-$((1+1))\necho b-$((2+2))"}); !r.OK {
		t.Fatalf("send by id: %+v", r)
	}
	waitFor(t, "two lines", func() bool { return strings.Contains(out(), "a-2") && strings.Contains(out(), "b-4") })
	// CRLF の改行も改行として受ける
	if r := do1(panecmd.Request{Cmd: "send", To: foo, Text: "echo c-$((5+5))\r\necho d-$((6+6))"}); !r.OK {
		t.Fatalf("send with CRLF: %+v", r)
	}
	waitFor(t, "two lines by CRLF", func() bool { return strings.Contains(out(), "c-10") && strings.Contains(out(), "d-12") })

	// キー。前景のコマンドを Ctrl+C で止める
	if r := do1(panecmd.Request{Cmd: "send", To: "foo", Text: "sleep 30; echo not-stopped"}); !r.OK {
		t.Fatal(r)
	}
	fooTerm, _ := srv.terms.get(foo)
	waitFor(t, "sleep in the foreground", fooTerm.busy)
	if r := do1(panecmd.Request{Cmd: "keys", To: "foo", Keys: []string{"ctrl+c"}}); !r.OK {
		t.Fatalf("keys ctrl+c: %+v", r)
	}
	if r := do1(panecmd.Request{Cmd: "send", To: "foo", Text: "echo after-$((3+3))"}); !r.OK {
		t.Fatal(r)
	}
	waitFor(t, "the shell after ctrl+c", func() bool { return strings.Contains(out(), "after-6") })
	if n := len(nt.all("pane.show")); n != focusBefore {
		t.Fatalf("sending must not move the focus: pane.show %d -> %d", focusBefore, n)
	}

	for _, bad := range []panecmd.Request{
		{Cmd: "send", To: "nope", Text: "x"},
		{Cmd: "send", To: "foo", Text: "a\x1b[201~b"},
		{Cmd: "send", To: "foo", Text: "a\rb"},
		{Cmd: "send", To: "foo", Text: strings.Repeat("a", maxSendText+1)},
		{Cmd: "keys", To: "foo"},
		{Cmd: "keys", To: "foo", Keys: []string{"esc", "hyper+x"}},
		{Cmd: "keys", To: "foo", Keys: slices.Repeat([]string{"esc"}, maxKeys+1)},
		{Cmd: "keys", To: "nope", Keys: []string{"esc"}},
		{Cmd: "close", To: "nope"},
		{Cmd: "close", To: p1},
	} {
		if r := do1(bad); r.OK || r.Error == "" {
			t.Fatalf("%+v must be refused with a reason: %+v", bad, r)
		}
	}
	if r := do1(panecmd.Request{Cmd: "send", To: "nope", Text: "x"}); !strings.Contains(r.Error, "no pane") {
		t.Fatalf("the reason for no pane: %+v", r)
	}
	if r := do1(panecmd.Request{Cmd: "close", To: p2}); !strings.Contains(r.Error, "primary") {
		t.Fatalf("the reason for the primary: %+v", r)
	}

	// 閉じる
	if r := do1(panecmd.Request{Cmd: "close", To: "foo"}); !r.OK || r.ID != foo {
		t.Fatalf("close: %+v", r)
	}
	if _, err := srv.terms.get(foo); err == nil {
		t.Fatal("the pane is still there")
	}
	if l := listWS(t, c).find(ws2).Layout; l.Pane != p2 {
		t.Fatalf("layout after close: %+v", l)
	}
	if _, err := srv.terms.find("foo"); !errors.Is(err, errNoSuchPane) {
		t.Fatalf("the name of a closed pane: %v", err)
	}
}

// bracketed paste を有効にしたプログラムには、文字を貼り付けとして送る。
func TestPaneCmdSendBracketedPaste(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	_, p := createWS(t, c)
	tok := termToken(t, srv, p)
	do := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = p, tok
		return paneCmdDo(t, sock, rq)
	}
	r := do(panecmd.Request{Cmd: "split", Dir: "right", Argv: []string{"/bin/sh", "-c", `stty -echo; printf '\033[?2004hREADY\n'; exec od -c`}})
	if !r.OK {
		t.Fatal(r)
	}
	id := r.ID
	waitFor(t, "ready", func() bool { d, _ := nt.output(t, id); return bytes.Contains(d, []byte("READY")) })
	if r := do(panecmd.Request{Cmd: "send", To: id, Text: "x"}); !r.OK {
		t.Fatal(r)
	}
	if r := do(panecmd.Request{Cmd: "keys", To: id, Keys: []string{"ctrl+d"}}); !r.OK {
		t.Fatal(r)
	}
	// od -c は ESC を 033 と書く。Enter（CR）は端末が改行にする（icrnl）
	waitFor(t, "the paste", func() bool {
		d, _ := nt.output(t, id)
		s := strings.Join(strings.Fields(string(d)), " ")
		return strings.Contains(s, "033 [ 2 0 0 ~ x 033 [ 2 0 1 ~ \\n")
	})
}

func TestModeScan(t *testing.T) {
	var s modeScan
	s.feed([]byte("abc\x1b[?2004h\x1b[?1"))
	if !s.bracketedPaste || s.appCursor {
		t.Fatalf("after ?2004h: %+v", s)
	}
	s.feed([]byte(";25h")) // 読みの境目で切れた列
	if !s.appCursor {
		t.Fatalf("after ?1;25h: %+v", s)
	}
	s.feed([]byte("\x1b[>1u\x1b[2004l\x1b[?2004l"))
	if s.bracketedPaste || !s.appCursor {
		t.Fatalf("after ?2004l: %+v", s)
	}
	s.feed([]byte("\x1b[?2004h\x1bc"))
	if s.bracketedPaste || s.appCursor {
		t.Fatalf("after RIS: %+v", s)
	}

	// 引き継ぎで渡す画面の状態の書き出しから、モードが戻る
	e, err := emulator.New(24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if _, err := e.Write([]byte("hello\x1b[?2004h\x1b[?1h")); err != nil {
		t.Fatal(err)
	}
	snap, err := e.Serialize(100)
	if err != nil {
		t.Fatal(err)
	}
	var s2 modeScan
	s2.feed(snap)
	if !s2.bracketedPaste || !s2.appCursor {
		t.Fatalf("the modes from the screen state %q: %+v", snap, s2)
	}
}

func TestKeyBytes(t *testing.T) {
	for _, c := range []struct {
		name string
		app  bool
		want string
	}{
		{"esc", false, "\x1b"},
		{"Escape", false, "\x1b"},
		{"ctrl+c", false, "\x03"},
		{"CTRL+A", false, "\x01"},
		{"enter", false, "\r"},
		{"up", false, "\x1b[A"},
		{"up", true, "\x1bOA"},
		{"home", true, "\x1bOH"},
		{"shift+tab", false, "\x1b[Z"},
		{"f5", false, "\x1b[15~"},
	} {
		if b, ok := keyBytes(c.name, c.app); !ok || string(b) != c.want {
			t.Errorf("keyBytes(%q, %v) = %q %v, want %q", c.name, c.app, b, ok, c.want)
		}
	}
	for _, bad := range []string{"", "ctrl+", "ctrl+1", "ctrl+ab", "alt+x", "f13"} {
		if _, ok := keyBytes(bad, false); ok {
			t.Errorf("keyBytes(%q) must be unknown", bad)
		}
	}
}

// 押し終えるまでの時間が kisui の待ち時間に収まるよう、キーの数に上限を置く。
func TestMaxKeysFitsTimeout(t *testing.T) {
	if d := time.Duration(maxKeys) * sendGap; d > panecmd.Timeout/2 {
		t.Fatalf("%d keys take %v, too close to the timeout of kisui (%v)", maxKeys, d, panecmd.Timeout)
	}
}

// 入力を読まないプログラムで PTY が詰まったら、待ち続けずに理由を付けて断る。GUI の term.input は、その期限で
// 失敗せず、読まれるまで待つ。終わったペインには送らない。
func TestPaneCmdSendStuckAndEnded(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	old := sendWriteTimeout
	sendWriteTimeout = 300 * time.Millisecond
	t.Cleanup(func() { sendWriteTimeout = old })
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	_, p := createWS(t, c)
	tok := termToken(t, srv, p)
	do := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = p, tok
		return paneCmdDo(t, sock, rq)
	}
	r := do(panecmd.Request{Cmd: "split", Dir: "right", Argv: []string{"/bin/sh", "-c", "stty -icanon -echo; echo READY; exec sleep 300"}})
	if !r.OK {
		t.Fatal(r)
	}
	id := r.ID
	waitFor(t, "ready", func() bool { d, _ := nt.output(t, id); return bytes.Contains(d, []byte("READY")) })
	big := strings.Repeat("a", maxSendText)
	var stuck panecmd.Reply
	for range 16 {
		if stuck = do(panecmd.Request{Cmd: "send", To: id, Text: big}); !stuck.OK {
			break
		}
	}
	if stuck.OK || !strings.Contains(stuck.Error, "does not read") {
		t.Fatalf("a stuck pane: %+v", stuck)
	}

	tm, _ := srv.terms.get(id)
	tm.mu.Lock()
	tm.alive = false
	tm.mu.Unlock()
	if r := do(panecmd.Request{Cmd: "keys", To: id, Keys: []string{"enter"}}); r.OK || !strings.Contains(r.Error, "ended") {
		t.Fatalf("an ended pane: %+v", r)
	}
	tm.mu.Lock()
	tm.alive = true
	tm.mu.Unlock()
}

// kisui pane send が付けた書きの期限に GUI の書き（term.input）が当たっても、失敗せずに読まれるまで待つ。
func TestWriteInputOutlivesDeadline(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	// パイプを詰まらせる
	_ = w.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
	filled := 0
	for {
		n, err := w.Write(make([]byte, 4096))
		filled += n
		if err != nil {
			break
		}
	}
	// 期限が切れたまま（send が書き終える前）に GUI が書く
	done := make(chan error, 1)
	go func() { done <- writeInput(w, []byte("gui")) }()
	time.Sleep(50 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("writeInput gave up on the deadline: %v", err)
	default:
	}
	_ = w.SetWriteDeadline(time.Time{}) // send が書き終えた
	got, err := io.ReadAll(io.LimitReader(r, int64(filled+3)))
	if err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(got, []byte("gui")) {
		t.Fatalf("the input of the GUI did not arrive: ...%q", got[max(0, len(got)-8):])
	}
}

// キーの一覧（knownKeys）は、keyBytes が引けるキーと合っている。kisui pane keys の使い方（en・ja）と SKILL.md にも
// 同じ一覧を書いている。
func TestKnownKeysMatchKeyBytes(t *testing.T) {
	listed := map[string]bool{}
	for k := range strings.SplitSeq(knownKeys, ", ") {
		switch k {
		case "f1-f12":
			for i := 1; i <= 12; i++ {
				listed[fmt.Sprintf("f%d", i)] = true
			}
		case "ctrl+a-ctrl+z":
			for c := 'a'; c <= 'z'; c++ {
				listed["ctrl+"+string(c)] = true
			}
		default:
			listed[k] = true
		}
	}
	for k := range listed {
		if _, ok := keyBytes(k, false); !ok {
			t.Errorf("knownKeys has %q, which keyBytes does not know", k)
		}
	}
	for k := range fixedKeys {
		if !listed[k] {
			t.Errorf("knownKeys lacks %q", k)
		}
	}
	for k := range cursorKeys {
		if !listed[k] {
			t.Errorf("knownKeys lacks %q", k)
		}
	}
	for _, lang := range []string{"en", "ja"} {
		i18n.SetLang(lang)
		if u := i18n.T("pane.keys.usage"); !strings.Contains(u, knownKeys) {
			t.Errorf("the usage (%s) does not list the keys of knownKeys: %s", lang, u)
		}
	}
	i18n.SetLang(i18n.Default)
}
