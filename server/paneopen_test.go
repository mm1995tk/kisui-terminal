package server

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// kisui pane open は、確かめてから GUI に pane.open を通知し、GUI の pane.opened を待って返す。
// GUI は workspace.create の argv・name で、名前の付いたペインでコマンドを動かすタブを作る。
func TestPaneCmdOpenTab(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	_, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	do := func(rq panecmd.Request) panecmd.Reply {
		rq.Cmd, rq.Pane, rq.Token = "open-tab", primary, token
		return paneCmdDo(t, sock, rq)
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	sh, _ = filepath.Abs(sh)
	cwd := normalizePath(t.TempDir())

	// GUI の役：届いた pane.open の n 番目（1 から）の中身
	type openParams struct {
		ID        string   `json:"id"`
		Workspace string   `json:"workspace"`
		New       bool     `json:"new"`
		Name      string   `json:"name"`
		Dir       string   `json:"dir"`
		Argv      []string `json:"argv"`
		Env       []string `json:"env"`
	}
	nth := func(n int) openParams {
		var p openParams
		waitFor(t, "pane.open", func() bool {
			all := nt.all("pane.open")
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
		done <- do(panecmd.Request{Workspace: " review ", Name: "reviewer", Cwd: cwd, Argv: []string{sh, "-c", "sleep 30"}, Env: []string{"FOO=1"}})
	}()
	p := nth(1)
	if p.ID == "" || p.Workspace != "review" || p.New || p.Name != "reviewer" || p.Dir != cwd || !slices.Equal(p.Argv, []string{sh, "-c", "sleep 30"}) || !slices.Equal(p.Env, []string{"FOO=1"}) {
		t.Fatalf("pane.open: %+v", p)
	}
	var created struct {
		ID     string `json:"id"`
		TermID string `json:"termId"`
	}
	if err := c.Call(context.Background(), "workspace.create", map[string]any{"dir": p.Dir, "argv": p.Argv, "env": p.Env, "name": p.Name}, &created); err != nil {
		t.Fatal(err)
	}
	tm, err := srv.terms.get(created.TermID)
	if err != nil {
		t.Fatal(err)
	}
	tm.mu.Lock()
	name, isPrimary, dir := tm.name, tm.primary, tm.cwd
	tm.mu.Unlock()
	if name != "reviewer" || !isPrimary || dir != cwd {
		t.Fatalf("the new tab: name %q primary %v cwd %q", name, isPrimary, dir)
	}
	if err := c.Notify("pane.opened", map[string]any{"id": p.ID, "termId": created.TermID}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; !r.OK || r.ID != created.TermID {
		t.Fatalf("open-tab: %+v", r)
	}
	// 新しいタブは前のフォーカスを変えない（serve は workspace.focus を受けていない）
	if _, f := srv.ws.snapshot(); f == created.ID {
		t.Fatal("the new tab took the focus")
	}

	// 名前が重なれば、GUI に頼まずに断る。GUI が作るとき（workspace.create）に重なっても、作らずに断る
	n := srv.ws.count()
	if r := do(panecmd.Request{Workspace: "review", Name: "reviewer"}); r.OK || !strings.Contains(r.Error, "already used") {
		t.Fatalf("a name in use: %+v", r)
	}
	if err := c.Call(context.Background(), "workspace.create", map[string]any{"name": "reviewer"}, &created); err == nil || !strings.Contains(err.Error(), "already used") {
		t.Fatalf("workspace.create with a name in use: %v", err)
	}
	if srv.ws.count() != n {
		t.Fatal("a workspace was made for a name in use")
	}
	if len(nt.all("pane.open")) != 1 {
		t.Fatal("asked the window for a name in use")
	}

	// GUI が断れば（ワークスペースが無いなど）、その理由で断る
	go func() { done <- do(panecmd.Request{Workspace: "nope", New: true, Name: "other"}) }()
	p = nth(2)
	if !p.New || p.Argv != nil || p.Dir == "" {
		t.Fatalf("pane.open with --new and no command: %+v", p)
	}
	if err := c.Notify("pane.opened", map[string]any{"id": p.ID, "error": "no workspace is named nope"}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; r.OK || r.Error != "no workspace is named nope" {
		t.Fatalf("refused by the window: %+v", r)
	}

	// 頼む前に確かめること
	for _, rq := range []panecmd.Request{
		{Workspace: "", Name: "x"},
		{Workspace: "a\nb", Name: "x"},
		{Workspace: "w", Name: ""},
		{Workspace: "w", Name: "t9"},
		{Workspace: "w", Name: "x", Cwd: filepath.Join(cwd, "missing")},
		{Workspace: "w", Name: "x", Argv: []string{"sh"}},
		{Workspace: "w", Name: "x", Env: []string{"=1"}},
	} {
		if r := do(rq); r.OK {
			t.Errorf("%+v: accepted", rq)
		}
	}
	if len(nt.all("pane.open")) != 2 {
		t.Fatal("asked the window for a bad request")
	}

	// GUI がつながっていなければ断る
	c.Close()
	waitFor(t, "owner gone", func() bool {
		srv.mu.Lock()
		defer srv.mu.Unlock()
		return srv.owner == nil
	})
	if r := do(panecmd.Request{Workspace: "review", Name: "x"}); r.OK || !strings.Contains(r.Error, "not connected") {
		t.Fatalf("no window: %+v", r)
	}
}
