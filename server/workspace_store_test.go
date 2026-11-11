package server

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

// lockedBuf はログを溜める（ログは別の goroutine から書かれる）。
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func primaryAlive(t *testing.T, c *rpc.Conn, id string) bool {
	t.Helper()
	var l struct {
		Terms []struct {
			TermID string `json:"termId"`
			Alive  bool   `json:"alive"`
		} `json:"terms"`
	}
	if err := c.Call(context.Background(), "term.list", struct{}{}, &l); err != nil {
		t.Fatal(err)
	}
	for _, x := range l.Terms {
		if x.TermID == id {
			return x.Alive
		}
	}
	return false
}

func primaryCwd(t *testing.T, srv *Server, id string) string {
	t.Helper()
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatalf("no terminal %s", id)
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.cwd
}

// ワークスペースを 2 つ（1 つはフォルダ未定）作って止めると、次の起動で同じ id・フォルダ・並びで戻る。
// プライマリターミナルは動いていて、そのフォルダ（未定なら start_dir）で始まる。分割したターミナルは戻らない。
func TestWorkspacesRestoredAfterShutdown(t *testing.T) {
	needCwd(t)
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	state := filepath.Join(t.TempDir(), "state", "workspaces.json")
	repo, _ := project(t)
	withState := func(o *Options) { o.StatePath = state }

	srv1, sock1 := startFastWith(t, withState)
	c1, _ := termClient(t, sock1)
	a, _ := createWS(t, c1) // start_dir（~）のまま
	b, bPrimary := createWS(t, c1)
	cd(t, c1, bPrimary, repo)
	waitFor(t, "folder", func() bool { return folderOfWS(t, c1, b) == repo })
	createTerm(t, c1, map[string]any{"workspaceId": b}) // 分割したターミナル
	waitFor(t, "saved", func() bool {
		l, err := loadState(state)
		return err == nil && len(l) == 2 && l[1].Folder == repo
	})
	if err := c1.Call(context.Background(), "server.shutdown", map[string]any{"force": true}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "stopped", func() bool { _, err := os.Stat(sock1); return err != nil })
	_ = srv1

	srv2, sock2 := startFastWith(t, withState)
	c2, _ := termClient(t, sock2)
	l := listWS(t, c2)
	if len(l.Workspaces) != 2 || l.Workspaces[0].ID != a || l.Workspaces[1].ID != b {
		t.Fatalf("restored: %+v", l.Workspaces)
	}
	if l.Focus != nil {
		t.Errorf("focus must not be restored")
	}
	xa, xb := l.Workspaces[0], l.Workspaces[1]
	if xa.Folder == nil || *xa.Folder != home {
		t.Errorf("a folder (start_dir): %v", xa.Folder)
	}
	if xb.Folder == nil || *xb.Folder != repo {
		t.Errorf("b folder: %v", xb.Folder)
	}
	for _, x := range l.Workspaces {
		if len(x.Terms) != 0 {
			t.Errorf("split terminals must not come back: %+v", x)
		}
		if !primaryAlive(t, c2, x.Primary) {
			t.Errorf("primary %s of %s is not running", x.Primary, x.ID)
		}
	}
	if got := primaryCwd(t, srv2, xa.Primary); got != home {
		t.Errorf("a starts in %q, want start_dir %q", got, home)
	}
	if got := primaryCwd(t, srv2, xb.Primary); got != repo {
		t.Errorf("b starts in %q, want %q", got, repo)
	}
	if srv2.terms.count() != 2 {
		t.Errorf("terminals: %d", srv2.terms.count())
	}
}

// 保存したフォルダがもう無いワークスペースは、start_dir（~）で始まり、フォルダもそこになる。
func TestWorkspaceRestoredWithoutMissingFolder(t *testing.T) {
	needCwd(t)
	home := normalizePath(t.TempDir())
	t.Setenv("HOME", home)
	gone := filepath.Join(t.TempDir(), "gone")
	state := filepath.Join(t.TempDir(), "workspaces.json")
	data := `{"version":1,"workspaces":[{"id":"wkeep","folder":"` + gone + `"}]}`
	if err := os.WriteFile(state, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, sock := startFastWith(t, func(o *Options) { o.StatePath = state })
	c, _ := termClient(t, sock)
	x := listWS(t, c).find("wkeep")
	if x == nil || x.Folder == nil || *x.Folder != home {
		t.Fatalf("restored: %+v", x)
	}
	if got := primaryCwd(t, srv, x.Primary); got != home {
		t.Errorf("starts in %q, want %q", got, home)
	}
	// 保存し直しても、ワークスペースは消えない（フォルダは start_dir になる）。
	waitFor(t, "saved", func() bool {
		l, err := loadState(state)
		return err == nil && len(l) == 1 && l[0].ID == "wkeep" && l[0].Folder == home
	})
}

// 壊れたファイルは、ワークスペースを戻さずに起動し、ログに書く。起動は止めない。
func TestWorkspacesFileBroken(t *testing.T) {
	for name, content := range map[string]string{
		"garbage":      "not json",
		"wrong shape":  `{"version":1,"workspaces":{"id":"w1"}}`,
		"unknown key":  `{"version":1,"workspaces":[],"extra":1}`,
		"version":      `{"version":99,"workspaces":[{"id":"w1"}]}`,
		"relative":     `{"version":1,"workspaces":[{"id":"w1","folder":"rel/dir"}]}`,
		"duplicate id": `{"version":1,"workspaces":[{"id":"w1"},{"id":"w1"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("HOME", normalizePath(t.TempDir()))
			state := filepath.Join(t.TempDir(), "workspaces.json")
			if err := os.WriteFile(state, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			var logs lockedBuf
			_, sock := startFastWith(t, func(o *Options) {
				o.StatePath = state
				o.Logger = slog.New(slog.NewTextHandler(&logs, nil))
			})
			c, _ := termClient(t, sock)
			if n := len(listWS(t, c).Workspaces); n != 0 {
				t.Fatalf("%d workspaces restored", n)
			}
			if !strings.Contains(logs.String(), "workspaces file is not read") {
				t.Errorf("log: %s", logs.String())
			}
			// そのあとはふつうに使え、新しい一覧で書き直す。
			id, _ := createWS(t, c)
			waitFor(t, "saved", func() bool {
				l, err := loadState(state)
				return err == nil && len(l) == 1 && l[0].ID == id
			})
		})
	}
}

// ワークスペースを閉じると、保存した一覧からも消える。StatePath が無ければ何も書かない。
func TestWorkspacesSavedOnChange(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	state := filepath.Join(t.TempDir(), "workspaces.json")
	_, sock := startFastWith(t, func(o *Options) { o.StatePath = state })
	c, _ := termClient(t, sock)
	a, _ := createWS(t, c)
	b, _ := createWS(t, c)
	waitFor(t, "two saved", func() bool {
		l, err := loadState(state)
		return err == nil && len(l) == 2 && l[0].ID == a && l[1].ID == b
	})
	if err := c.Call(context.Background(), "workspace.close", map[string]any{"id": a, "force": true}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "one saved", func() bool {
		l, err := loadState(state)
		return err == nil && len(l) == 1 && l[0].ID == b
	})
	if fi, err := os.Stat(state); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("state file: %v %v", fi, err)
	}
}
