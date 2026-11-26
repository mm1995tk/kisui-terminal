package server

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// --machine の付いた頼みは、確かめてから GUI に pane.relay を通知し、GUI の pane.relayed を待って返す。
func TestPaneCmdRelay(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	_, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	do := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = primary, token
		return paneCmdDo(t, sock, rq)
	}

	// GUI の役：届いた pane.relay の n 番目（1 から）の中身
	type relayParams struct {
		ID      string         `json:"id"`
		Machine string         `json:"machine"`
		Request map[string]any `json:"request"`
	}
	nth := func(n int) relayParams {
		var p relayParams
		waitFor(t, "pane.relay", func() bool {
			all := nt.all("pane.relay")
			if len(all) < n {
				return false
			}
			_ = json.Unmarshal(*all[n-1], &p)
			return true
		})
		return p
	}

	done := make(chan panecmd.Reply, 1)
	go func() {
		done <- do(panecmd.Request{Cmd: "send", Machine: " local ", To: "foo", Text: "echo hi"})
	}()
	p := nth(1)
	if p.ID == "" || p.Machine != "local" || p.Request["cmd"] != "send" || p.Request["to"] != "foo" || p.Request["text"] != "echo hi" {
		t.Fatalf("pane.relay: %+v", p)
	}
	for _, k := range []string{"pane", "token", "machine"} {
		if _, ok := p.Request[k]; ok {
			t.Fatalf("pane.relay passes %q: %+v", k, p.Request)
		}
	}
	if err := c.Notify("pane.relayed", map[string]any{"id": p.ID, "reply": map[string]any{"ok": true, "id": "t7"}}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; !r.OK || r.ID != "t7" {
		t.Fatalf("relayed send: %+v", r)
	}

	// 相手が断れば（マシンが無いなど）、その理由で断る
	go func() { done <- do(panecmd.Request{Cmd: "read", Machine: "dev", To: "bar", Lines: 3}) }()
	p = nth(2)
	if p.Machine != "dev" || p.Request["cmd"] != "read" || p.Request["lines"] != float64(3) {
		t.Fatalf("pane.relay of read: %+v", p)
	}
	if err := c.Notify("pane.relayed", map[string]any{"id": p.ID, "reply": map[string]any{"error": "no machine is named dev"}}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; r.OK || r.Error != "no machine is named dev" {
		t.Fatalf("refused by the window: %+v", r)
	}

	// kisui pane open は、フォルダとコマンドを相手のマシンのものとして（絶対パスのまま）渡す
	go func() {
		done <- do(panecmd.Request{Cmd: "open-tab", Machine: "dev", Workspace: " review ", Name: "reviewer", Cwd: "/srv/repo", Argv: []string{"/usr/bin/claude", "-c"}})
	}()
	p = nth(3)
	if p.Request["cmd"] != "open-tab" || p.Request["workspace"] != "review" || p.Request["name"] != "reviewer" || p.Request["cwd"] != "/srv/repo" {
		t.Fatalf("pane.relay of open-tab: %+v", p)
	}
	if argv, _ := p.Request["argv"].([]any); len(argv) != 2 || argv[0] != "/usr/bin/claude" {
		t.Fatalf("pane.relay of open-tab: %+v", p)
	}
	if err := c.Notify("pane.relayed", map[string]any{"id": p.ID, "reply": map[string]any{"ok": true, "id": "t1"}}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; !r.OK || r.ID != "t1" {
		t.Fatalf("relayed open-tab: %+v", r)
	}

	// 頼む前に確かめること
	for _, rq := range []panecmd.Request{
		{Cmd: "send", Machine: "  ", To: "foo", Text: "x"},
		{Cmd: "title", Machine: "dev", Title: "x"},
		{Cmd: "split", Machine: "dev", Dir: "right"},
		{Cmd: "update", Machine: "dev"},
		{Cmd: "open-tab", Machine: "dev", Workspace: "", Name: "x"},
		{Cmd: "open-tab", Machine: "dev", Workspace: "w", Name: ""},
		{Cmd: "open-tab", Machine: "dev", Workspace: "w", Name: "x", Cwd: "repo"},
		{Cmd: "open-tab", Machine: "dev", Workspace: "w", Name: "x", Argv: []string{"claude"}},
	} {
		if r := do(rq); r.OK {
			t.Errorf("%+v: accepted", rq)
		}
	}
	if len(nt.all("pane.relay")) != 3 {
		t.Fatal("asked the window for a bad request")
	}

	// GUI がつながっていなければ断る
	c.Close()
	waitFor(t, "owner gone", func() bool {
		srv.mu.Lock()
		defer srv.mu.Unlock()
		return srv.owner == nil
	})
	if r := do(panecmd.Request{Cmd: "list", Machine: "dev"}); r.OK || !strings.Contains(r.Error, "not connected") {
		t.Fatalf("no window: %+v", r)
	}
}

// pane.run は、別のマシンから GUI が中継した頼みを、このマシンで行う。断るときも返事の error で答える。
func TestPaneRun(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFastAll(t)
	c, _ := termClient(t, sock)
	_, primary := createWS(t, c)
	tm, err := srv.terms.get(primary)
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.terms.setName(tm, "foo"); err != nil {
		t.Fatal(err)
	}
	run := func(rq map[string]any) panecmd.Reply {
		var r panecmd.Reply
		if err := c.Call(context.Background(), "pane.run", rq, &r); err != nil {
			t.Fatal(err)
		}
		return r
	}

	r := run(map[string]any{"cmd": "list"})
	if !r.OK || len(r.Panes) != 1 || r.Panes[0].ID != primary || r.Panes[0].Name != "foo" || r.Panes[0].Self {
		t.Fatalf("list: %+v", r)
	}
	if r := run(map[string]any{"cmd": "send", "to": "foo", "text": "echo hi"}); !r.OK || r.ID != primary {
		t.Fatalf("send: %+v", r)
	}
	if r := run(map[string]any{"cmd": "read", "to": "foo"}); !r.OK || r.ID != primary {
		t.Fatalf("read: %+v", r)
	}
	for _, rq := range []map[string]any{
		{"cmd": "send", "to": "nope", "text": "x"},
		{"cmd": "split", "dir": "right"},
		{"cmd": "open-tab", "workspace": "w", "name": "x"},
		{"cmd": "title", "title": "x"},
	} {
		if r := run(rq); r.OK || r.Error == "" {
			t.Errorf("%v: %+v", rq, r)
		}
	}
	// 中継の頼みを受けられる印
	var hello HelloResult
	if err := c.Call(context.Background(), "session.hello", map[string]any{"protocol": Protocol, "client": map[string]any{"name": "t"}}, &hello); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(hello.Capabilities, CapPaneRun) {
		t.Fatalf("capabilities: %v", hello.Capabilities)
	}
}
