package server

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// windowClient は、capabilities を名乗る Window の役（空なら名乗らない古い Window）。
func windowClient(t *testing.T, sock string, caps ...string) (*rpc.Conn, *notes) {
	t.Helper()
	nt := &notes{}
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	cn := rpc.NewConn(c, rpc.JSON{}, nt.handle)
	t.Cleanup(func() { cn.Close() })
	h := hello(Protocol.Major)
	if len(caps) > 0 {
		h["capabilities"] = caps
	}
	if err := cn.Call(context.Background(), "session.hello", h, nil); err != nil {
		t.Fatal(err)
	}
	return cn, nt
}

type windowRunNote struct {
	ID      string          `json:"id"`
	Pane    string          `json:"pane"`
	Tab     string          `json:"tab"`
	Command string          `json:"command"`
	Args    json.RawMessage `json:"args"`
}

func nthWindowRun(t *testing.T, nt *notes, n int) windowRunNote {
	t.Helper()
	var p windowRunNote
	waitFor(t, "window.run", func() bool {
		all := nt.all("window.run")
		if len(all) < n {
			return false
		}
		_ = json.Unmarshal(*all[n-1], &p)
		return true
	})
	return p
}

// Window に頼むコマンドは、頼んだ Pane とその Terminal tab を添えて window.run で Window に渡り、window.ran の result がそのまま返る。
func TestWindowRun(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := windowClient(t, sock, CapWindowRun)
	ws, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	do := func(rq panecmd.Request) panecmd.Reply {
		rq.Cmd, rq.Pane, rq.Token = "window", primary, token
		return paneCmdDo(t, sock, rq)
	}

	done := make(chan panecmd.Reply, 1)
	go func() {
		done <- do(panecmd.Request{Command: "tab.rename", Args: json.RawMessage(`{"tab":"a","name":"b"}`)})
	}()
	p := nthWindowRun(t, nt, 1)
	if p.ID == "" || p.Pane != primary || p.Tab != ws || p.Command != "tab.rename" || string(p.Args) != `{"tab":"a","name":"b"}` {
		t.Fatalf("window.run: %+v", p)
	}
	if err := c.Notify("window.ran", map[string]any{"id": p.ID, "result": map[string]any{"id": "w1"}}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; !r.OK || string(r.Result) != `{"id":"w1"}` {
		t.Fatalf("reply: %+v", r)
	}

	// 引数が無ければ、空のオブジェクトを渡す。断りは、理由と code がそのまま返る
	go func() { done <- do(panecmd.Request{Command: "tab.close"}) }()
	p = nthWindowRun(t, nt, 2)
	if string(p.Args) != `{}` {
		t.Fatalf("args: %s", p.Args)
	}
	_ = c.Notify("window.ran", map[string]any{"id": p.ID, "error": "a program is running", "code": panecmd.CodeBusy})
	if r := <-done; r.OK || r.Error != "a program is running" || r.Code != panecmd.CodeBusy {
		t.Fatalf("refusal: %+v", r)
	}

	// Window は not-in-pane を付けられない（コマンドが「Pane の中でない」と読む）
	go func() { done <- do(panecmd.Request{Command: "tab.close"}) }()
	p = nthWindowRun(t, nt, 3)
	_ = c.Notify("window.ran", map[string]any{"id": p.ID, "error": "no", "code": panecmd.CodeNotInPane})
	if r := <-done; r.OK || r.Error != "no" || r.Code != "" {
		t.Fatalf("code from the window: %+v", r)
	}

	// 形の合わない頼みは、Window に送らずに断る
	for _, rq := range []panecmd.Request{
		{Command: ""},
		{Command: "tab"},
		{Command: "Tab.rename"},
		{Command: "tab.rename", Args: json.RawMessage(`[1]`)},
		{Command: "tab.rename", Args: json.RawMessage(`{"a":`)},
	} {
		if r := do(rq); r.OK {
			t.Fatalf("%+v was sent to the window", rq)
		}
	}
	if n := len(nt.all("window.run")); n != 3 {
		t.Fatalf("window.run was sent %d times", n)
	}

	// 秘密が合わなければ、Pane の中でない
	if r := paneCmdDo(t, sock, panecmd.Request{Cmd: "window", Command: "tab.list", Pane: primary, Token: "x"}); r.Code != panecmd.CodeNotInPane {
		t.Fatalf("wrong token: %+v", r)
	}
}

// Window がつながっていなければ断り、印の無い古い Window には送らない。
func TestWindowRunNoWindowAndOldWindow(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := windowClient(t, sock) // 印の無い Window
	_, primary := createWS(t, c)
	rq := panecmd.Request{Cmd: "window", Command: "tab.list", Pane: primary, Token: termToken(t, srv, primary)}
	if r := paneCmdDo(t, sock, rq); r.OK || !strings.Contains(r.Error, "older than this kisui") {
		t.Fatalf("an old window: %+v", r)
	}
	if n := len(nt.all("window.run")); n != 0 {
		t.Fatalf("window.run was sent to an old window %d times", n)
	}
	c.Close()
	waitFor(t, "the window to go away", func() bool {
		_, ok := srv.ownerCapabilities()
		return !ok
	})
	if r := paneCmdDo(t, sock, rq); r.OK || r.Code != panecmd.CodeNoWindow || !strings.Contains(r.Error, "not connected") {
		t.Fatalf("no window: %+v", r)
	}
}

// 答えが来なければ、時間切れを理由と一緒に返し、取り下げを知らせる。long の頼みは長く待つ。
func TestWindowRunWithdraws(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	old := windowRunLongWait
	windowRunLongWait = 300 * time.Millisecond
	t.Cleanup(func() { windowRunLongWait = old })
	srv, sock := startFast(t)
	c, nt := windowClient(t, sock, CapWindowRun)
	_, primary := createWS(t, c)
	start := time.Now()
	r := paneCmdDo(t, sock, panecmd.Request{Cmd: "window", Command: "clipboard.history", Long: true, Pane: primary, Token: termToken(t, srv, primary)})
	if r.OK || !strings.Contains(r.Error, "did not answer in time") {
		t.Fatalf("no answer: %+v", r)
	}
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Fatalf("gave up after %v, before the wait", d)
	}
	p := nthWindowRun(t, nt, 1)
	var cancel struct {
		ID string `json:"id"`
	}
	waitFor(t, "window.runCancel", func() bool {
		cs := nt.all("window.runCancel")
		if len(cs) != 1 {
			return false
		}
		_ = json.Unmarshal(*cs[0], &cancel)
		return true
	})
	if cancel.ID != p.ID {
		t.Fatalf("withdraws another request: %q, want %q", cancel.ID, p.ID)
	}
}
