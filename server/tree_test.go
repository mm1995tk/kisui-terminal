package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

type tEntry struct {
	Name        string `json:"name"`
	NameRaw     string `json:"nameRaw"`
	Kind        string `json:"kind"`
	Target      string `json:"target"`
	Size        *int64 `json:"size"`
	Git         string `json:"git"`
	GitChildren bool   `json:"gitChildren"`
}

type tList struct {
	Entries   []tEntry `json:"entries"`
	Truncated bool     `json:"truncated"`
	Rev       int64    `json:"rev"`
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	for _, a := range [][]string{{"init", "-q"}, {"config", "user.email", "t@example.com"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", a...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
}

func gitDo(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// treeEnv は git のリポジトリ（.git あり）をワークスペースにして接続する。
func treeEnv(t *testing.T) (c *rpc.Conn, nt *notes, root, wsid string) {
	t.Helper()
	root = normalizePath(t.TempDir())
	gitInit(t, root)
	_, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	c, nt = termClient(t, sock)
	wsid, _ = createWS(t, c)
	return c, nt, root, wsid
}

func call(t *testing.T, c *rpc.Conn, method string, p map[string]any, out any) error {
	t.Helper()
	return c.Call(context.Background(), method, p, out)
}

func rpcCode(err error) int {
	if e, ok := err.(*rpc.Error); ok {
		return e.Code
	}
	return 0
}

func names(l tList) []string {
	var n []string
	for _, e := range l.Entries {
		n = append(n, e.Name)
	}
	return n
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestTreeListOrderAndIgnore(t *testing.T) {
	c, _, root, id := treeEnv(t)
	write(t, filepath.Join(root, ".gitignore"), "build/\n*.log\n")
	write(t, filepath.Join(root, "b.txt"), "bb")
	write(t, filepath.Join(root, "A.txt"), "a")
	write(t, filepath.Join(root, ".env"), "x")
	write(t, filepath.Join(root, "zdir", "in.go"), "")
	write(t, filepath.Join(root, ".dotdir", "f"), "")
	write(t, filepath.Join(root, "adir", "f"), "")
	write(t, filepath.Join(root, "build", "out"), "")
	write(t, filepath.Join(root, "x.log"), "")
	os.Symlink("b.txt", filepath.Join(root, "link"))
	os.Symlink("adir", filepath.Join(root, "dlink"))

	var l tList
	if err := call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": ""}, &l); err != nil {
		t.Fatal(err)
	}
	// ドットのフォルダ、フォルダ（フォルダへのリンクも）、ドットのファイル、ファイル。.git は出さない。
	want := []string{".dotdir", "adir", "build", "dlink", "zdir", ".env", ".gitignore", "A.txt", "b.txt", "link", "x.log"}
	if !eq(names(l), want) {
		t.Fatalf("order: %v\nwant %v", names(l), want)
	}
	by := map[string]tEntry{}
	for _, e := range l.Entries {
		by[e.Name] = e
	}
	if by["build"].Git != "!" || by["x.log"].Git != "!" {
		t.Errorf("ignored: build=%q x.log=%q", by["build"].Git, by["x.log"].Git)
	}
	if by["b.txt"].Git != "?" || by["zdir"].Git != "" || !by["zdir"].GitChildren || by["adir"].Kind != "dir" {
		t.Errorf("marks: %+v %+v", by["b.txt"], by["zdir"])
	}
	if by["link"].Kind != "symlink" || by["link"].Target != "b.txt" || by["b.txt"].Size == nil || *by["b.txt"].Size != 2 {
		t.Errorf("kinds: %+v %+v", by["link"], by["b.txt"])
	}
	if l.Truncated {
		t.Error("must not be truncated")
	}
	// 無視されたフォルダの中身は "!" になる。
	var sub tList
	call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": "build"}, &sub)
	if len(sub.Entries) != 1 || sub.Entries[0].Git != "!" {
		t.Errorf("under ignored: %+v", sub.Entries)
	}
	call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": "zdir"}, &sub)
	if len(sub.Entries) != 1 || sub.Entries[0].Name != "in.go" || sub.Entries[0].Git != "?" {
		t.Errorf("sub: %+v", sub.Entries)
	}
	if err := call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": "nope"}, nil); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("missing dir: %v", err)
	}
	if err := call(t, c, "tree.list", map[string]any{"workspaceId": "wnone", "path": ""}, nil); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("missing ws: %v", err)
	}
}

func TestTreeListTruncates(t *testing.T) {
	c, _, root, id := treeEnv(t)
	for i := range treeLimit + 3 {
		write(t, filepath.Join(root, "f"+strconv.Itoa(i)), "")
	}
	var l tList
	if err := call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": ""}, &l); err != nil {
		t.Fatal(err)
	}
	if len(l.Entries) != treeLimit || !l.Truncated {
		t.Fatalf("got %d truncated=%v", len(l.Entries), l.Truncated)
	}
}

func TestTreeDeniedOutsideRoot(t *testing.T) {
	c, _, root, id := treeEnv(t)
	outside := normalizePath(t.TempDir())
	write(t, filepath.Join(outside, "secret"), "")
	write(t, filepath.Join(outside, "sub", "x"), "")
	os.Symlink(outside, filepath.Join(root, "escape"))
	os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "esc-file"))
	write(t, filepath.Join(root, "ok.txt"), "")
	os.Symlink(".git", filepath.Join(root, "gitlink"))

	for _, p := range []string{"..", "../x", "a/../../x", "/etc", outside, "escape", "escape/sub"} {
		if err := call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": p}, nil); rpcCode(err) != rpc.CodeDenied {
			t.Errorf("list %q: %v", p, err)
		}
	}
	// ルートの外を指すリンクは、リンクのまま一覧には出る（中は開けない）。
	var l tList
	call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": ""}, &l)
	if !eq(names(l), []string{"escape", "gitlink", "esc-file", "ok.txt"}) {
		t.Errorf("links must be listed: %v", names(l))
	}
	for _, m := range []struct {
		method string
		p      map[string]any
	}{
		{"tree.create", map[string]any{"path": "../x", "kind": "file"}},
		{"tree.create", map[string]any{"path": "escape/new", "kind": "file"}},
		{"tree.create", map[string]any{"path": "escape/deep/new", "kind": "dir"}},
		{"tree.rename", map[string]any{"from": "ok.txt", "to": "../ok.txt"}},
		{"tree.rename", map[string]any{"from": "ok.txt", "to": "escape/ok.txt"}},
		{"tree.rename", map[string]any{"from": "../secret", "to": "ok2"}},
		{"tree.delete", map[string]any{"path": "escape/secret"}},
		{"tree.delete", map[string]any{"path": "../x"}},
		{"tree.delete", map[string]any{"path": ".git"}},
		{"tree.delete", map[string]any{"path": "gitlink/objects"}},
		{"tree.create", map[string]any{"path": "gitlink/x", "kind": "file"}},
		{"tree.rename", map[string]any{"from": "ok.txt", "to": "gitlink/ok.txt"}},
		{"tree.watch", map[string]any{"paths": []string{"escape"}}},
	} {
		m.p["workspaceId"] = id
		if err := call(t, c, m.method, m.p, nil); rpcCode(err) != rpc.CodeDenied {
			t.Errorf("%s %v: %v", m.method, m.p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "secret")); err != nil {
		t.Error("outside file was touched")
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
		t.Error("created outside")
	}
	// リンクの削除はリンクだけを消し、先は消さない。
	if err := call(t, c, "tree.delete", map[string]any{"workspaceId": id, "path": "escape"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "escape")); err == nil {
		t.Error("link not removed")
	}
	if _, err := os.Stat(filepath.Join(outside, "secret")); err != nil {
		t.Error("link target was removed")
	}
}

func TestTreeInvalidUTF8Name(t *testing.T) {
	c, _, root, id := treeEnv(t)
	raw := "bad\xff\xfename.txt"
	if err := os.WriteFile(filepath.Join(root, raw), nil, 0o644); err != nil {
		t.Skipf("filesystem refuses the name: %v", err)
	}
	write(t, filepath.Join(root, "good"), "")
	var l tList
	if err := call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": ""}, &l); err != nil {
		t.Fatal(err)
	}
	var bad *tEntry
	for i, e := range l.Entries {
		if e.NameRaw != "" {
			bad = &l.Entries[i]
		} else if e.Name == "good" && e.NameRaw != "" {
			t.Error("good name must not have nameRaw")
		}
	}
	if bad == nil {
		t.Fatalf("no nameRaw: %+v", l.Entries)
	}
	got, _ := base64.StdEncoding.DecodeString(bad.NameRaw)
	if string(got) != raw || bad.Name != "bad�name.txt" {
		t.Errorf("name=%q raw=%q", bad.Name, got)
	}
}

func TestTreeMutations(t *testing.T) {
	c, _, root, id := treeEnv(t)
	ws := map[string]any{"workspaceId": id}
	with := func(p map[string]any) map[string]any {
		m := map[string]any{}
		maps.Copy(m, ws)
		maps.Copy(m, p)
		return m
	}
	if err := call(t, c, "tree.create", with(map[string]any{"path": "d/e/new.txt", "kind": "file"}), nil); err != nil {
		t.Fatal(err)
	}
	if err := call(t, c, "tree.create", with(map[string]any{"path": "d2", "kind": "dir"}), nil); err != nil {
		t.Fatal(err)
	}
	if err := call(t, c, "tree.create", with(map[string]any{"path": "d2", "kind": "dir"}), nil); err == nil {
		t.Error("creating an existing path must fail")
	}
	if err := call(t, c, "tree.create", with(map[string]any{"path": "x", "kind": "pipe"}), nil); rpcCode(err) != rpc.CodeInvalidParams {
		t.Errorf("bad kind: %v", err)
	}
	write(t, filepath.Join(root, "keep"), "keep")
	if err := call(t, c, "tree.rename", with(map[string]any{"from": "d/e/new.txt", "to": "keep"}), nil); err == nil {
		t.Error("rename must not overwrite")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "keep")); string(b) != "keep" {
		t.Error("existing file overwritten")
	}
	if err := call(t, c, "tree.rename", with(map[string]any{"from": "d/e/new.txt", "to": "moved/renamed.txt"}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "moved", "renamed.txt")); err != nil {
		t.Error(err)
	}
	if err := call(t, c, "tree.delete", with(map[string]any{"path": "d"}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "d")); err == nil {
		t.Error("not deleted")
	}
	if err := call(t, c, "tree.delete", with(map[string]any{"path": "d"}), nil); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("delete missing: %v", err)
	}
	if err := call(t, c, "tree.delete", with(map[string]any{"path": ""}), nil); err == nil {
		t.Error("deleting the root must fail")
	}
}

func TestTreeWatchSendsChanged(t *testing.T) {
	c, nt, root, id := treeEnv(t)
	write(t, filepath.Join(root, "watched", "a"), "")
	write(t, filepath.Join(root, "other", "a"), "")
	var l tList
	call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": "watched"}, &l)
	if err := call(t, c, "tree.watch", map[string]any{"workspaceId": id, "paths": []string{"watched", ""}}, nil); err != nil {
		t.Fatal(err)
	}
	// 変化が無い間は届かない。見ていないフォルダの変化も届かない。
	write(t, filepath.Join(root, "other", "b"), "")
	time.Sleep(150 * time.Millisecond)
	if n := len(nt.all("tree.changed")); n != 0 {
		t.Fatalf("unexpected tree.changed x%d", n)
	}
	write(t, filepath.Join(root, "watched", "b"), "new")
	waitFor(t, "tree.changed", func() bool { return len(nt.all("tree.changed")) > 0 })
	var m struct {
		WorkspaceID string   `json:"workspaceId"`
		Paths       []string `json:"paths"`
		Rev         int64    `json:"rev"`
	}
	mustJSON(t, *nt.all("tree.changed")[0], &m)
	if m.WorkspaceID != id || !eq(m.Paths, []string{"watched"}) || m.Rev <= l.Rev {
		t.Fatalf("tree.changed: %+v (list rev %d)", m, l.Rev)
	}
	var l2 tList
	call(t, c, "tree.list", map[string]any{"workspaceId": id, "path": "watched"}, &l2)
	if len(l2.Entries) != 2 || l2.Rev < m.Rev {
		t.Errorf("relist: %+v", l2)
	}
	// 同じ状態なら増えない。
	time.Sleep(150 * time.Millisecond)
	if n := len(nt.all("tree.changed")); n != 1 {
		t.Errorf("tree.changed x%d", n)
	}
	// 自分で作ったものはすぐ届く。
	call(t, c, "tree.create", map[string]any{"workspaceId": id, "path": "watched/c", "kind": "file"}, nil)
	waitFor(t, "tree.changed after create", func() bool { return len(nt.all("tree.changed")) > 1 })
	// 監視を外すと届かない。
	call(t, c, "tree.watch", map[string]any{"workspaceId": id, "paths": []string{}}, nil)
	write(t, filepath.Join(root, "watched", "d"), "")
	time.Sleep(150 * time.Millisecond)
	if n := len(nt.all("tree.changed")); n != 2 {
		t.Errorf("tree.changed after unwatch x%d", n)
	}
}

func TestGitStatusAndChanged(t *testing.T) {
	c, nt, root, id := treeEnv(t)
	write(t, filepath.Join(root, "a.txt"), "1")
	write(t, filepath.Join(root, "sub", "b.txt"), "1")
	gitDo(t, root, "add", ".")
	gitDo(t, root, "commit", "-qm", "init")
	write(t, filepath.Join(root, "a.txt"), "2")
	write(t, filepath.Join(root, "sub", "new.txt"), "")

	var st struct {
		Branch string            `json:"branch"`
		Marks  map[string]string `json:"marks"`
		Rev    int64             `json:"rev"`
	}
	if err := call(t, c, "git.status", map[string]any{"workspaceId": id}, &st); err != nil {
		t.Fatal(err)
	}
	if st.Branch == "" || st.Marks["a.txt"] != "M" || st.Marks["sub/new.txt"] != "?" || len(st.Marks) != 2 || st.Rev == 0 {
		t.Fatalf("status: %+v", st)
	}
	// 印が変わると git.changed が差分だけ届く。2 つの変更の間に監視が発火すると、
	// 通知は 2 回に分かれることがあるので、届いた通知をまとめて見る。
	gitDo(t, root, "checkout", "-q", "--", "a.txt")
	write(t, filepath.Join(root, "sub", "b.txt"), "2")
	type changed struct {
		WorkspaceID string             `json:"workspaceId"`
		Branch      *string            `json:"branch"`
		Marks       map[string]*string `json:"marks"`
		Rev         int64              `json:"rev"`
	}
	marks := map[string]*string{}
	merge := func() {
		marks = map[string]*string{}
		for _, raw := range nt.all("git.changed") {
			var m changed
			mustJSON(t, *raw, &m)
			if m.WorkspaceID != id || m.Branch != nil || m.Rev <= st.Rev {
				t.Fatalf("git.changed: %+v", m)
			}
			maps.Copy(marks, m.Marks)
		}
	}
	waitFor(t, "git.changed", func() bool {
		merge()
		_, a := marks["a.txt"]
		_, b := marks["sub/b.txt"]
		return a && b
	})
	if v, ok := marks["a.txt"]; !ok || v != nil {
		t.Errorf("a.txt must be null: %+v", marks)
	}
	if v := marks["sub/b.txt"]; v == nil || *v != "M" {
		t.Errorf("sub/b.txt: %+v", marks)
	}
	if _, ok := marks["sub/new.txt"]; ok {
		t.Error("unchanged mark must not be sent")
	}
	// ブランチが変わると branch が届く。
	n := len(nt.all("git.changed"))
	gitDo(t, root, "checkout", "-qb", "feature")
	waitFor(t, "branch", func() bool {
		all := nt.all("git.changed")
		if len(all) <= n {
			return false
		}
		var b struct{ Branch *string }
		mustJSON(t, *all[len(all)-1], &b)
		return b.Branch != nil && *b.Branch == "feature"
	})
}

func mustJSON(t *testing.T, raw []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}
