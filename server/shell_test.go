package server

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

// fakeShell は、/bin/sh を動かす、name という名前のシェル（どのシェルで始まったかを、パスで見分ける）。
// /bin/sh へのリンクにはしない：busybox の sh は、呼ばれた名前で動きを決めるので、別の名前では動かない。
func fakeShell(t *testing.T, dir, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexec /bin/sh \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// shellOfTerm は、ターミナル id で動いているプログラムのパスと、その環境変数 SHELL（無ければ ""）。
func shellOfTerm(t *testing.T, srv *Server, id string) (path, shellEnv string) {
	t.Helper()
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatalf("no terminal %s", id)
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for _, e := range tm.cmd.Env {
		if v, ok := strings.CutPrefix(e, "SHELL="); ok {
			shellEnv = v // 後に書いたものが勝つ
		}
	}
	return tm.cmd.Path, shellEnv
}

func createWith(t *testing.T, c *rpc.Conn, params map[string]any) (id, primary string, err error) {
	t.Helper()
	var r struct {
		ID     string `json:"id"`
		TermID string `json:"termId"`
	}
	err = c.Call(context.Background(), "workspace.create", params, &r)
	return r.ID, r.TermID, err
}

// session.hello の capabilities に、窓がシェルと始めるフォルダを渡せる印がある。
func TestHelloHasCreateShell(t *testing.T) {
	_, sock := start(t)
	c := dial(t, sock)
	var r struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), &r); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r.Capabilities, CapCreateShell) {
		t.Errorf("capabilities: %v", r.Capabilities)
	}
}

// workspace.create の startDir は、dir が無い・使えないときに始めるフォルダ（~ はこのマシンのホーム）。
// dir があればそちらが勝ち、startDir も使えなければ [server] start_dir（無ければ ~）。
func TestWorkspaceCreateStartDir(t *testing.T) {
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	work, proj := filepath.Join(home, "work"), filepath.Join(home, "proj")
	for _, d := range []string{work, proj} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	for _, tc := range []struct {
		name   string
		params map[string]any
		want   string
	}{
		{"~/x", map[string]any{"startDir": "~/work"}, work},
		{"absolute", map[string]any{"startDir": work}, work},
		{"~", map[string]any{"startDir": "~"}, home},
		{"dir wins", map[string]any{"dir": proj, "startDir": "~/work"}, proj},
		{"dir is gone", map[string]any{"dir": filepath.Join(home, "gone"), "startDir": "~/work"}, work},
		{"startDir is gone", map[string]any{"startDir": "~/gone"}, home},
		{"relative", map[string]any{"startDir": "work"}, home},
		{"empty", map[string]any{"startDir": ""}, home},
	} {
		id, _, err := createWith(t, c, tc.params)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got := folderOfWS(t, c, id); got != tc.want {
			t.Errorf("%s: folder %q, want %q", tc.name, got, tc.want)
		}
	}
}

// workspace.create の shell でプライマリターミナルが始まり、そのワークスペースで窓を通さずに始まるシェルと、
// shell を付けない term.create も同じシェルになる。shell を付けた term.create・term.restart は、そのシェルで始めて覚え直し、
// 空の shell はこのマシンの既定（[server] shell）に戻す。
func TestShellOfWorkspace(t *testing.T) {
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	bin := filepath.Join(home, "bin")
	one, two, own := fakeShell(t, bin, "one"), fakeShell(t, bin, "two"), fakeShell(t, bin, "own")
	srv, sock := startFastWith(t, func(o *Options) { o.Shell = own })
	c, _ := termClient(t, sock)
	ctx := context.Background()
	is := func(what, term, want string) {
		t.Helper()
		if path, env := shellOfTerm(t, srv, term); path != want || env != want {
			t.Errorf("%s: runs %q with SHELL=%q, want %q", what, path, env, want)
		}
	}
	split := func(params map[string]any) string {
		t.Helper()
		var r struct {
			TermID string `json:"termId"`
		}
		p := map[string]any{"cols": 80, "rows": 24}
		maps.Copy(p, params)
		if err := c.Call(ctx, "term.create", p, &r); err != nil {
			t.Fatal(err)
		}
		return r.TermID
	}

	// 何も渡さなければ、このマシンの既定（[server] shell）
	plain, plainPrimary, err := createWith(t, c, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	is("no shell", plainPrimary, own)
	is("split without a shell", split(map[string]any{"workspaceId": plain}), own)

	id, primary, err := createWith(t, c, map[string]any{"shell": "~/bin/one"})
	if err != nil {
		t.Fatal(err)
	}
	is("workspace.create", primary, one)
	is("split without a shell", split(map[string]any{"workspaceId": id}), one)
	// kisui pane split と同じ道（窓を通さない）
	tm, err := srv.terms.start(termStart{cols: 80, rows: 24, dir: home, wsID: id})
	if err != nil {
		t.Fatal(err)
	}
	is("started by serve", tm.id, one)

	is("split with a shell", split(map[string]any{"workspaceId": id, "shell": two}), two)
	is("split after that", split(map[string]any{"workspaceId": id}), two)
	is("split with an empty shell", split(map[string]any{"workspaceId": id, "shell": ""}), own)
	is("split after the empty shell", split(map[string]any{"workspaceId": id}), own)

	// 使えないシェルは、別のシェルに替えずに断る（覚えているものも変えない）
	for _, bad := range []string{"~/bin/none", "one", "~/bin", "~/bin/one -l"} {
		err := c.Call(ctx, "term.create", map[string]any{"workspaceId": id, "cols": 80, "rows": 24, "shell": bad}, nil)
		e, ok := err.(*rpc.Error)
		var data struct{ Reason, Shell string }
		if ok {
			_ = json.Unmarshal(e.Data, &data)
		}
		if !ok || e.Code != rpc.CodeInvalidParams || data.Reason != "shell" || data.Shell == "" {
			t.Errorf("term.create with shell %q: %v (%+v)", bad, err, data)
		}
	}
	is("split after the refusals", split(map[string]any{"workspaceId": id}), own)
	// 始められなかった要求（分ける先の欄が無い）のシェルも、覚えない
	if err := c.Call(ctx, "term.create", map[string]any{"workspaceId": id, "cols": 80, "rows": 24, "shell": two, "split": map[string]any{"target": "none", "dir": "right"}}, nil); err == nil {
		t.Error("a split of a pane that is not there was accepted")
	}
	is("split after the failed request", split(map[string]any{"workspaceId": id}), own)
	before := len(listWS(t, c).Workspaces)
	if _, _, err := createWith(t, c, map[string]any{"shell": "~/bin/none"}); !isCode(err, rpc.CodeInvalidParams) {
		t.Errorf("workspace.create with a shell that is not there: %v", err)
	}
	if n := len(listWS(t, c).Workspaces); n != before {
		t.Errorf("a refused workspace.create made a workspace: %d -> %d", before, n)
	}
}

// term.restart も shell を受ける（kisui pane open のコマンドが終わったあとの、Enter で始めるシェル）。
func TestTermRestartWithShell(t *testing.T) {
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	one := fakeShell(t, filepath.Join(home, "bin"), "one")
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	exited := func() int { return len(nt.all("term.exit")) }
	_, primary, err := createWith(t, c, map[string]any{"argv": []string{"/bin/sh", "-c", "exit 0"}, "name": "worker", "shell": one})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the command ends", func() bool { return exited() == 1 })
	if err := c.Call(ctx, "term.restart", map[string]any{"termId": primary, "shell": "~/bin/none"}, nil); !isCode(err, rpc.CodeInvalidParams) {
		t.Fatalf("restart with a shell that is not there: %v", err)
	}
	// shell を付けなければ、作ったときに覚えたシェル
	if err := c.Call(ctx, "term.restart", map[string]any{"termId": primary}, nil); err != nil {
		t.Fatal(err)
	}
	if path, env := shellOfTerm(t, srv, primary); path != one || env != one {
		t.Errorf("restart: runs %q with SHELL=%q, want %q", path, env, one)
	}
}

// 止まった serve が作り直すワークスペースは、覚えていたシェルで始まる。そのシェルがもう無ければ、このマシンの既定で始まる
// （ワークスペースは失わない）。
func TestShellRestoredAfterShutdown(t *testing.T) {
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	bin := filepath.Join(home, "bin")
	one, gone := fakeShell(t, bin, "one"), fakeShell(t, bin, "gone")
	state := filepath.Join(t.TempDir(), "state", "workspaces.json")
	withState := func(o *Options) { o.StatePath = state }

	_, sock1 := startFastWith(t, withState)
	c1, _ := termClient(t, sock1)
	a, _, err := createWith(t, c1, map[string]any{"shell": "~/bin/one"})
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := createWith(t, c1, map[string]any{"shell": gone})
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := createWS(t, c1)
	waitFor(t, "saved", func() bool {
		l, err := loadState(state)
		return err == nil && len(l) == 3 && l[0].Shell == "~/bin/one" && l[1].Shell == gone && l[2].Shell == ""
	})
	if err := c1.Call(context.Background(), "server.shutdown", map[string]any{"force": true}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "stopped", func() bool { _, err := os.Stat(sock1); return err != nil })
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}

	srv2, sock2 := startFastWith(t, withState)
	c2, _ := termClient(t, sock2)
	l := listWS(t, c2)
	if len(l.Workspaces) != 3 {
		t.Fatalf("restored: %+v", l.Workspaces)
	}
	for id, want := range map[string]string{a: one, b: "/bin/sh", plain: "/bin/sh"} {
		x := l.find(id)
		if x == nil {
			t.Fatalf("workspace %s is not restored", id)
		}
		if path, _ := shellOfTerm(t, srv2, x.Primary); path != want {
			t.Errorf("workspace %s runs %q, want %q", id, path, want)
		}
	}
}

// このマシンの既定（[server] の start_dir と shell）は、使うたびに設定を読み直す。設定から消せば、serve を止めずに、
// 次のターミナルから $SHELL とホームに戻る（窓は、書いていない項目を空で渡す）。読めない間は、最後に読めた値。
func TestMachineDefaultsAreReadAgain(t *testing.T) {
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	own := fakeShell(t, filepath.Join(home, "bin"), "own")
	work := filepath.Join(home, "work")
	if err := os.Mkdir(work, 0o755); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	dir, sh, ok := work, own, true // 今の設定ファイルの [server]
	set := func(d, s string, readable bool) {
		mu.Lock()
		defer mu.Unlock()
		dir, sh, ok = d, s, readable
	}
	srv, sock := startFastWith(t, func(o *Options) {
		o.StartDir, o.Shell = work, own
		o.ReadDefaults = func() (string, string, bool) {
			mu.Lock()
			defer mu.Unlock()
			return dir, sh, ok
		}
	})
	c, _ := termClient(t, sock)
	// 窓が空を渡したときの、始まるフォルダとシェル
	started := func() (folder, shell string) {
		t.Helper()
		id, primary, err := createWith(t, c, map[string]any{"startDir": "", "shell": ""})
		if err != nil {
			t.Fatal(err)
		}
		shell, _ = shellOfTerm(t, srv, primary)
		return folderOfWS(t, c, id), shell
	}
	if f, s := started(); f != work || s != own {
		t.Errorf("with [server]: %q %q", f, s)
	}
	// 設定に間違いがある間は、最後に読めた値
	set("", "", false)
	if f, s := started(); f != work || s != own {
		t.Errorf("while the settings cannot be read: %q %q", f, s)
	}
	// 設定から消した：serve は止めていない
	set("", "", true)
	if f, s := started(); f != home || s != "/bin/sh" {
		t.Errorf("after the keys are removed: %q %q, want %q /bin/sh", f, s, home)
	}
	// 書き直した
	set("", own, true)
	if f, s := started(); f != home || s != own {
		t.Errorf("after shell is written again: %q %q", f, s)
	}
}
