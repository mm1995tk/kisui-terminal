package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

func startFast(t *testing.T) (*Server, string) {
	t.Helper()
	return startFastWith(t, nil)
}

func startFastWith(t *testing.T, mod func(*Options)) (*Server, string) {
	t.Helper()
	return startWith(t, func(o *Options) {
		o.CwdInterval = 20 * time.Millisecond
		o.TreeInterval = 20 * time.Millisecond
		o.GitInterval = 50 * time.Millisecond
		if mod != nil {
			mod(o)
		}
	})
}

// all は method の通知をすべて返す。
func (n *notes) all(method string) []*json.RawMessage {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []*json.RawMessage
	for _, m := range n.got {
		if m.Method == method {
			p := m.Params
			out = append(out, &p)
		}
	}
	return out
}

type wsList struct {
	Workspaces []wsInfo `json:"workspaces"`
	Focus      *string  `json:"focus"`
}

// listWS は workspace.list の結果。
func listWS(t *testing.T, c *rpc.Conn) wsList {
	t.Helper()
	var l wsList
	if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil {
		t.Fatal(err)
	}
	return l
}

// find は id のワークスペース。無ければ nil。
func (l wsList) find(id string) *wsInfo {
	for i := range l.Workspaces {
		if l.Workspaces[i].ID == id {
			return &l.Workspaces[i]
		}
	}
	return nil
}

func cd(t *testing.T, c *rpc.Conn, term, dir string) {
	t.Helper()
	if err := c.Call(context.Background(), "term.input", map[string]any{"termId": term, "data": b64("cd '" + dir + "'\n")}, nil); err != nil {
		t.Fatal(err)
	}
}

// folderOfWS は id のワークスペースのフォルダ。未定なら ""。
func folderOfWS(t *testing.T, c *rpc.Conn, id string) string {
	t.Helper()
	x := listWS(t, c).find(id)
	if x == nil {
		t.Fatalf("no workspace %s", id)
	}
	if x.Folder == nil {
		return ""
	}
	return *x.Folder
}

// project は .git のあるフォルダ（pkg というサブフォルダ付き）。
func project(t *testing.T) (root, sub string) {
	t.Helper()
	root = normalizePath(t.TempDir())
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub = filepath.Join(root, "pkg")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	return root, sub
}

func needCwd(t *testing.T) {
	t.Helper()
	if _, err := shellCwd(os.Getpid()); err != nil {
		t.Skipf("cannot read cwd: %v", err)
	}
}

// workspace.create はフォルダ未定のワークスペースとプライマリターミナルをすぐ作る。
// シェルは start_dir（無ければ ~）で始まる。
func TestWorkspaceCreateIsUndecided(t *testing.T) {
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)

	l := listWS(t, c)
	x := l.find(id)
	if x == nil || x.Folder != nil || x.Kind != nil || x.Name != nil || x.Primary != primary || len(x.Terms) != 0 || len(x.Files) != 0 {
		t.Fatalf("workspace: %+v", x)
	}
	if l.Focus != nil {
		t.Errorf("create must not take the focus: %v", *l.Focus)
	}
	var raw struct {
		Workspaces []map[string]json.RawMessage `json:"workspaces"`
	}
	c.Call(context.Background(), "workspace.list", map[string]any{}, &raw)
	if string(raw.Workspaces[0]["folder"]) != "null" || string(raw.Workspaces[0]["name"]) != "null" {
		t.Errorf("folder and name must be null: %s", raw.Workspaces[0])
	}
	waitFor(t, "workspace.changed", func() bool { return len(nt.all("workspace.changed")) > 0 })

	var tl struct {
		Terms []struct {
			TermID      string `json:"termId"`
			Cwd         string `json:"cwd"`
			WorkspaceID string `json:"workspaceId"`
			Primary     bool   `json:"primary"`
		} `json:"terms"`
	}
	if err := c.Call(context.Background(), "term.list", map[string]any{}, &tl); err != nil || len(tl.Terms) != 1 {
		t.Fatalf("terms: %+v %v", tl, err)
	}
	if tm := tl.Terms[0]; tm.TermID != primary || tm.Cwd != home || tm.WorkspaceID != id || !tm.Primary {
		t.Errorf("primary: %+v", tm)
	}
	// 新しい要求は新しいワークスペースを作る（同じフォルダでも）。
	id2, _ := createWS(t, c)
	if id2 == id || len(listWS(t, c).Workspaces) != 2 {
		t.Errorf("second workspace: %s %s", id, id2)
	}
}

// start_dir がプロジェクトの中なら、作ったときにフォルダが決まる。同じフォルダを指すワークスペースは
// 2 つ以上作れて、id はフォルダから作らない。
func TestWorkspaceStartDirInProjectAndSameFolder(t *testing.T) {
	root, sub := project(t)
	_, sock := startFastWith(t, func(o *Options) { o.StartDir = sub })
	c, _ := termClient(t, sock)
	a, _ := createWS(t, c)
	b, _ := createWS(t, c)
	l := listWS(t, c)
	if len(l.Workspaces) != 2 || a == b {
		t.Fatalf("workspaces: %+v", l)
	}
	for _, id := range []string{a, b} {
		x := l.find(id)
		if x == nil || x.Folder == nil || *x.Folder != root || *x.Kind != "git" || *x.Name != filepath.Base(root) {
			t.Errorf("workspace %s: %+v", id, x)
		}
	}
}

// プライマリターミナルが別のフォルダへ cd したら、ワークスペースのフォルダが切り替わる（新しいワークスペースは
// 増えず、id も変わらない）。core は閉じて作り直す。~ と / へ移っても、同じフォルダの中で移っても、
// 切り替えない。分割したターミナルの cd は何も起こさない。
func TestWorkspaceFollowsPrimaryCd(t *testing.T) {
	needCwd(t)
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	repo, sub := project(t)
	repo2, _ := project(t)
	srv, sock := startFast(t)
	fc := &fakeCores{}
	srv.SetCores(fc)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	split := createTerm(t, c, map[string]any{"workspaceId": id})
	if err := c.Call(ctx, "workspace.focus", map[string]any{"id": id}, nil); err != nil {
		t.Fatal(err)
	}

	// 分割したターミナルの cd は何もしない。
	cd(t, c, split, repo)
	time.Sleep(200 * time.Millisecond)
	if f := folderOfWS(t, c, id); f != "" {
		t.Fatalf("a split terminal's cd set the folder: %s", f)
	}

	// プライマリターミナルの cd でフォルダが決まる（サブフォルダからでも、.git のあるフォルダに）。
	cd(t, c, primary, sub)
	waitFor(t, "folder", func() bool { return folderOfWS(t, c, id) == repo })
	if n := len(listWS(t, c).Workspaces); n != 1 {
		t.Fatalf("%d workspaces", n)
	}
	changed := len(nt.all("workspace.changed"))

	// 同じフォルダの中の cd では何も起きない。
	rel := fc.count(&fc.released, id)
	cd(t, c, primary, repo)
	time.Sleep(200 * time.Millisecond)
	if fc.count(&fc.released, id) != rel || len(nt.all("workspace.changed")) != changed {
		t.Errorf("cd inside the folder switched it")
	}

	// ~ と / では切り替えない。
	for _, d := range []string{home, "/"} {
		cd(t, c, primary, d)
		waitFor(t, "cwd "+d, func() bool {
			tm, _ := srv.terms.get(primary)
			tm.mu.Lock()
			defer tm.mu.Unlock()
			return tm.cwd == normalizePath(d)
		})
		time.Sleep(100 * time.Millisecond)
		if f := folderOfWS(t, c, id); f != repo {
			t.Fatalf("cd %s: folder = %q", d, f)
		}
	}
	if fc.count(&fc.released, id) != rel {
		t.Errorf("cd ~ and / released the files")
	}

	// 別のプロジェクトへ cd すると切り替わる。ファイルは閉じ（Release）、フォーカスしているので core は新しいフォルダで開き直す。
	cd(t, c, primary, repo2)
	waitFor(t, "switch", func() bool { return folderOfWS(t, c, id) == repo2 })
	if fc.count(&fc.released, id) != rel+1 {
		t.Errorf("released %v", fc.released)
	}
	if fc.count(&fc.opened, id+"="+repo2) != 1 {
		t.Errorf("opened %v", fc.opened)
	}
	x := listWS(t, c).find(id)
	if x == nil || len(x.Terms) != 1 || x.Terms[0] != split || x.Primary != primary {
		t.Errorf("after switch: %+v", x)
	}
	var upd bool
	for _, raw := range nt.all("workspace.changed") {
		var m struct{ Updated []wsInfo }
		json.Unmarshal(*raw, &m)
		for _, u := range m.Updated {
			upd = upd || (u.ID == id && u.Folder != nil && *u.Folder == repo2)
		}
	}
	if !upd {
		t.Error("no workspace.changed with the new folder")
	}
}

// 行き先を指すワークスペースがすでにあっても、まとめない。
func TestWorkspaceCdDoesNotMerge(t *testing.T) {
	needCwd(t)
	t.Setenv("HOME", normalizePath(t.TempDir()))
	repo, _ := project(t)
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	a, pa := createWS(t, c)
	b, _ := createWS(t, c)
	cd(t, c, pa, repo)
	waitFor(t, "a", func() bool { return folderOfWS(t, c, a) == repo })
	// b も同じフォルダへ。
	pb := listWS(t, c).find(b).Primary
	cd(t, c, pb, repo)
	waitFor(t, "b", func() bool { return folderOfWS(t, c, b) == repo })
	if n := len(listWS(t, c).Workspaces); n != 2 {
		t.Errorf("%d workspaces, want 2", n)
	}
}

// workspace.close は、ターミナルを全部終わらせてワークスペースを消す。
func TestWorkspaceClose(t *testing.T) {
	root, _ := project(t)
	srv, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	fc := &fakeCores{}
	srv.SetCores(fc)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	split := createTerm(t, c, map[string]any{"workspaceId": id})
	other, _ := createWS(t, c)

	if err := c.Call(ctx, "workspace.close", map[string]any{"id": "nope"}, nil); !isCode(err, rpc.CodeNotFound) {
		t.Errorf("unknown: %v", err)
	}
	if err := c.Call(ctx, "workspace.close", map[string]any{"id": id}, nil); err != nil {
		t.Fatal(err)
	}
	if fc.count(&fc.saved, id) != 1 || fc.count(&fc.closed, id) != 1 {
		t.Errorf("saved %v closed %v", fc.saved, fc.closed)
	}
	l := listWS(t, c)
	if l.find(id) != nil || l.find(other) == nil {
		t.Errorf("list: %+v", l)
	}
	for _, tm := range []string{primary, split} {
		if _, err := srv.terms.get(tm); err == nil {
			t.Errorf("terminal %s is still there", tm)
		}
	}
	waitFor(t, "removed", func() bool {
		for _, raw := range nt.all("workspace.changed") {
			var m struct{ Removed []string }
			if json.Unmarshal(*raw, &m); len(m.Removed) == 1 && m.Removed[0] == id {
				return true
			}
		}
		return false
	})
}

// プログラムが動いているターミナルがあれば、force が無い限り busy で断る（何も閉じない）。
func TestWorkspaceCloseBusyWhenProgramRuns(t *testing.T) {
	srv, sock := startFast(t)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	c.Call(ctx, "term.input", map[string]any{"termId": primary, "data": b64("sleep 60\n")}, nil)
	tm, _ := srv.terms.get(primary)
	waitFor(t, "program running", tm.busy)
	err := c.Call(ctx, "workspace.close", map[string]any{"id": id}, nil)
	if !isCode(err, rpc.CodeBusy) {
		t.Fatalf("err = %v", err)
	}
	e := err.(*rpc.Error)
	var d struct{ Reason string }
	json.Unmarshal(e.Data, &d)
	if d.Reason != "running" || listWS(t, c).find(id) == nil {
		t.Fatalf("data %s, list %+v", e.Data, listWS(t, c))
	}
	if err := c.Call(ctx, "workspace.close", map[string]any{"id": id, "force": true}, nil); err != nil {
		t.Fatal(err)
	}
	if listWS(t, c).find(id) != nil {
		t.Error("force did not close")
	}
}

// 保存できなかったファイルがあれば、force でも何も閉じずに busy（unsaved）で断る。
func TestWorkspaceCloseKeepsUnsavedFiles(t *testing.T) {
	root, _ := project(t)
	srv, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	fc := &fakeCores{failSave: []string{root + "/a.txt"}}
	srv.SetCores(fc)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	err := c.Call(ctx, "workspace.close", map[string]any{"id": id, "force": true}, nil)
	if !isCode(err, rpc.CodeBusy) {
		t.Fatalf("err = %v", err)
	}
	var d struct {
		Reason string
		Paths  []string
	}
	json.Unmarshal(err.(*rpc.Error).Data, &d)
	if d.Reason != "unsaved" || len(d.Paths) != 1 || d.Paths[0] != root+"/a.txt" {
		t.Errorf("data %s", err.(*rpc.Error).Data)
	}
	if listWS(t, c).find(id) == nil {
		t.Error("the workspace was closed")
	}
	if tm, err := srv.terms.get(primary); err != nil || !tm.aliveNow() {
		t.Error("the terminal was ended")
	}
	if fc.count(&fc.closed, id) != 0 {
		t.Error("the core was closed")
	}
}

// ワークスペースは、シェルがいなくなっても消えない。
func TestWorkspaceStaysWhenPrimaryExits(t *testing.T) {
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	c.Call(context.Background(), "term.input", map[string]any{"termId": primary, "data": b64("exit\n")}, nil)
	waitFor(t, "exit", func() bool { return nt.find("term.exit") != nil })
	time.Sleep(100 * time.Millisecond)
	if listWS(t, c).find(id) == nil {
		t.Error("the workspace went with its shell")
	}
}

func (t *terminal) aliveNow() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.alive
}
