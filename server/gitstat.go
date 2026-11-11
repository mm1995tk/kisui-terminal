package server

// git の印（git.status / git.changed）と、tree.list の git / gitChildren / "!"。
// 印の求め方は core/explorer.go の loadGitStatus と同じ（git status --porcelain -z）。
// 印の文字は設計書の表に合わせる：M 変更、A 追加、D 削除、R 名前変更、? 追跡していない、U 衝突、! .gitignore で無視。

import (
	"context"
	"maps"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// gitState は 1 回の git status の結果。作ったあとは書き換えない。
type gitState struct {
	branch  string
	marks   map[string]string // ルートからの相対パス -> 文字（無視されたものは入れない）
	dirs    map[string]bool   // 印のあるものの親フォルダ（ルートは除く）
	ignored map[string]bool   // 無視されたパス。フォルダは中身ぜんぶを表す
	rev     int64
}

// isIgnored は p か、その親のどれかが無視されているか。
func (g *gitState) isIgnored(p string) bool {
	for ; p != "." && p != ""; p = path.Dir(p) {
		if g.ignored[p] {
			return true
		}
	}
	return false
}

type gitCache struct {
	m  *treeManager
	mu sync.Mutex
	// run は 1 つのワークスペースの更新を 1 つずつにする（通知の順を保つ）。
	run sync.Mutex
	by  map[string]*gitState
}

func newGitCache(m *treeManager) *gitCache { return &gitCache{m: m, by: map[string]*gitState{}} }

// state は id の最新の結果。まだ無ければ取る。git のリポジトリでなければ nil。
func (c *gitCache) state(id, root string) *gitState {
	c.mu.Lock()
	g := c.by[id]
	c.mu.Unlock()
	if g != nil {
		return g
	}
	return c.refresh(id, root)
}

// refresh は git status を取り直し、前回との差を git.changed で送る。
func (c *gitCache) refresh(id, root string) *gitState {
	c.run.Lock()
	defer c.run.Unlock()
	// git の印を取るのは kind が "git" のワークスペースだけ（~ や / のフォルダで git status をかけ続けない）。
	if !c.m.srv.ws.isGit(id) {
		c.mu.Lock()
		delete(c.by, id)
		c.mu.Unlock()
		return nil
	}
	next, ok := readGit(root)
	c.mu.Lock()
	prev := c.by[id]
	c.mu.Unlock()
	if !ok {
		return nil
	}
	if prev != nil && sameGit(prev, next) {
		return prev
	}
	next.rev = c.m.gitRev.Add(1)
	c.mu.Lock()
	c.by[id] = next
	c.mu.Unlock()
	if prev == nil {
		return next
	}
	p := map[string]any{"workspaceId": id, "rev": next.rev}
	if prev.branch != next.branch {
		p["branch"] = next.branch
	}
	if d := marksDiff(prev.marks, next.marks); len(d) > 0 {
		p["marks"] = d
	}
	c.m.srv.notifyOwner("git.changed", p)
	// 無視の変化は tree.list の "!" に出る。見ているフォルダを取り直させる。
	if !maps.Equal(prev.ignored, next.ignored) {
		c.m.w.invalidate(id)
	}
	return next
}

func (c *gitCache) refreshAsync(id, root string) {
	c.m.srv.wg.Go(func() { c.refresh(id, root) })
}

func sameGit(a, b *gitState) bool {
	return a.branch == b.branch && maps.Equal(a.marks, b.marks) && maps.Equal(a.ignored, b.ignored)
}

// marksDiff は変わった分。消えた印は nil。
func marksDiff(prev, next map[string]string) map[string]any {
	d := map[string]any{}
	for k, v := range next {
		if prev[k] != v {
			d[k] = v
		}
	}
	for k := range prev {
		if _, ok := next[k]; !ok {
			d[k] = nil
		}
	}
	return d
}

// scan は取ったことのあるワークスペースの git の印を取り直す。消えたワークスペースは捨てる。
func (c *gitCache) scan() {
	c.mu.Lock()
	ids := make([]string, 0, len(c.by))
	for id := range c.by {
		ids = append(ids, id)
	}
	c.mu.Unlock()
	for _, id := range ids {
		root, ok := c.m.srv.ws.rootOf(id)
		if !ok {
			c.mu.Lock()
			delete(c.by, id)
			c.mu.Unlock()
			continue
		}
		c.refresh(id, root)
	}
}

func (c *gitCache) status(id, root string) (any, error) {
	g := c.refresh(id, root)
	out := map[string]any{"branch": "", "marks": map[string]string{}, "rev": c.m.gitRev.Load()}
	if g == nil {
		return out, nil
	}
	out["branch"], out["marks"], out["rev"] = g.branch, g.marks, g.rev
	if a, b, ok := aheadBehind(root); ok {
		if a > 0 {
			out["ahead"] = a
		}
		if b > 0 {
			out["behind"] = b
		}
	}
	return out, nil
}

func gitRun(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// --no-optional-locks: 状態を読むだけで index を書いて、ユーザーの git と競らない。
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks"}, args...)...)
	cmd.Dir = dir
	return cmd.Output()
}

func aheadBehind(root string) (ahead, behind int, ok bool) {
	out, err := gitRun(root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err != nil {
		return 0, 0, false
	}
	f := strings.Fields(string(out))
	if len(f) != 2 {
		return 0, 0, false
	}
	a, err1 := strconv.Atoi(f[0])
	b, err2 := strconv.Atoi(f[1])
	return a, b, err1 == nil && err2 == nil
}

// readGit は root の git status を読む。git のリポジトリの中でなければ ok == false。
func readGit(root string) (*gitState, bool) {
	top, err := gitRun(root, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, false
	}
	topDir := strings.TrimSpace(string(top))
	if r, err := filepath.EvalSymlinks(topDir); err == nil {
		topDir = r
	}
	// --ignored=matching は無視されたフォルダを 1 件にまとめる。
	out, err := gitRun(root, "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "-z")
	if err != nil {
		out, err = gitRun(root, "status", "--porcelain", "--untracked-files=all", "-z")
		if err != nil {
			return nil, false
		}
	}
	g := &gitState{marks: map[string]string{}, dirs: map[string]bool{}, ignored: map[string]bool{}, branch: gitBranch(root)}
	rel := func(p string) (string, bool) {
		r, err := filepath.Rel(root, filepath.Join(topDir, p))
		if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return "", false
		}
		return filepath.ToSlash(r), true
	}
	parts := strings.Split(string(out), "\x00")
	for i := 0; i < len(parts); i++ {
		p := parts[i]
		if len(p) < 4 {
			continue
		}
		xy, name := p[:2], p[3:]
		if xy[0] == 'R' || xy[0] == 'C' {
			i++ // 元のパスが続く
		}
		r, ok := rel(strings.TrimSuffix(name, "/"))
		if !ok || r == "." {
			continue
		}
		if xy == "!!" {
			g.ignored[r] = true
			continue
		}
		g.marks[r] = gitLetter(xy)
		for d := path.Dir(r); d != "." && d != "/"; d = path.Dir(d) {
			g.dirs[d] = true
		}
	}
	return g, true
}

// gitLetter は git status --porcelain の 2 文字から印を決める。
func gitLetter(xy string) string {
	switch {
	case xy == "??":
		return "?"
	case xy[0] == 'U' || xy[1] == 'U' || xy == "AA" || xy == "DD":
		return "U"
	case xy[0] == 'A':
		return "A"
	case xy[0] == 'D' || xy[1] == 'D':
		return "D"
	case xy[0] == 'R' || xy[0] == 'C':
		return "R"
	}
	return "M"
}
