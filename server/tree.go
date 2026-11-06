package server

// ファイルのツリー（tree.*）。設計は docs/design/gui-protocol.md の「ファイルのツリー」。
//
// core の Explorer（TUI の 1 つの木）とは別の、状態を持たない取得の API。開閉とスクロールは GUI が持つ。
// 並び順と「.git は出さない」は TUI のツリー（core/explorer.go の nodeLess）と同じにしてある。
// TUI の木は選択・開閉の状態と一緒になっていて、そのままは共有できないので、並べ方だけを写した。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"unicode/utf8"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// treeLimit は tree.list が 1 回で返す件数の上限。
const treeLimit = 5000

type treeEntry struct {
	Name        string `json:"name"`
	NameRaw     string `json:"nameRaw,omitempty"` // 名前が UTF-8 でないときの元のバイト列（base64）
	Kind        string `json:"kind"`              // "file" | "dir" | "symlink"
	Target      string `json:"target,omitempty"`
	Size        *int64 `json:"size,omitempty"`
	Git         string `json:"git,omitempty"`
	GitChildren bool   `json:"gitChildren,omitempty"`

	isDir bool // シンボリックリンクの先がフォルダでも true（並べ方と gitChildren の判定に使う）
}

type treeManager struct {
	srv    *Server
	rev    atomic.Int64 // ツリー専用の版。Screen.Rev とは別
	gitRev atomic.Int64 // git 専用の版
	w      *treeWatcher
	g      *gitCache
}

func newTreeManager(s *Server) *treeManager {
	m := &treeManager{srv: s}
	m.w = newTreeWatcher(m)
	m.g = newGitCache(m)
	return m
}

// errDenied は root の外へ出るパスのエラー。
func errDenied(p string) *rpc.Error {
	return rpc.Errorf(rpc.CodeDenied, "path is outside the workspace: %s", p)
}

// cleanRel はクライアントのパスを root からの相対パス（"/" 区切り、"" はルート）にする。
// 絶対パスと ".." を含むものは denied。
func cleanRel(p string) (string, error) {
	if strings.ContainsRune(p, 0) {
		return "", rpc.Errorf(rpc.CodeInvalidParams, "invalid path")
	}
	if strings.HasPrefix(p, "/") || filepath.IsAbs(p) {
		return "", errDenied(p)
	}
	if slices.Contains(strings.Split(p, "/"), "..") {
		return "", errDenied(p)
	}
	c := path.Clean(p)
	if c == "." {
		return "", nil
	}
	return c, nil
}

func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// resolveDir は rel のフォルダ（最後がシンボリックリンクならその先）の実パスを返す。
// 実パスが root の外なら denied。root は正規化済み（シンボリックリンクをたどった絶対パス）。
func resolveDir(root, rel string) (string, error) {
	full := filepath.Join(root, filepath.FromSlash(rel))
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", rpc.Errorf(rpc.CodeNotFound, "no such directory: %s", rel)
		}
		return "", rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	if !within(root, real) {
		return "", errDenied(rel)
	}
	return real, nil
}

// resolveEntry は rel の「項目そのもの」の実パスを返す。最後の部品はたどらない（シンボリックリンクはリンクのまま扱う）。
// 親のフォルダが root の外を指していれば denied。親がまだ無いとき（作成）は、あるところまで遡って確かめる。
func resolveEntry(root, rel string) (string, error) {
	if rel == "" {
		return "", rpc.Errorf(rpc.CodeInvalidParams, "the workspace root cannot be changed")
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	dir, base := filepath.Split(full)
	dir = filepath.Clean(dir)
	var rest []string
	for {
		real, err := filepath.EvalSymlinks(dir)
		if err == nil {
			if !within(root, real) {
				return "", errDenied(rel)
			}
			parts := append([]string{real}, rest...)
			res := filepath.Join(append(parts, base)...)
			// .git は、リンクをたどった実パスで調べる（.git を指すリンク越しでも触らせない）。
			if r, err := filepath.Rel(root, res); err == nil && slices.Contains(strings.Split(r, string(filepath.Separator)), gitDirName) {
				return "", rpc.Errorf(rpc.CodeDenied, ".git cannot be changed: %s", rel)
			}
			return res, nil
		}
		if !errors.Is(err, fs.ErrNotExist) || dir == root {
			return "", rpc.Errorf(rpc.CodeInternalError, "%v", err)
		}
		rest = append([]string{filepath.Base(dir)}, rest...)
		dir = filepath.Dir(dir)
	}
}

// validName は名前を JSON に載せられる形にする。UTF-8 でないときは不正な部分を � にして元を base64 で添える。
func validName(n string) (name, raw string) {
	if utf8.ValidString(n) {
		return n, ""
	}
	return strings.ToValidUTF8(n, "�"), base64.StdEncoding.EncodeToString([]byte(n))
}

// entryLess は TUI の nodeLess と同じ順：ドットのフォルダ、フォルダ、ドットのファイル、ファイル。
func entryLess(a, b *treeEntry, an, bn string) bool {
	if a.isDir != b.isDir {
		return a.isDir
	}
	ad, bd := strings.HasPrefix(an, "."), strings.HasPrefix(bn, ".")
	if ad != bd {
		return ad
	}
	return strings.ToLower(an) < strings.ToLower(bn)
}

type listed struct {
	e   treeEntry
	raw string // 元の名前
}

// listDir は abs（実パス）の 1 階層。rel はそのルートからの相対パス。git は印の表（無ければ nil）。
func listDir(abs, rel string, g *gitState) ([]treeEntry, bool, error) {
	ents, err := os.ReadDir(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, rpc.Errorf(rpc.CodeNotFound, "no such directory: %s", rel)
		}
		if errors.Is(err, fs.ErrPermission) {
			return nil, false, rpc.Errorf(rpc.CodeDenied, "%v", err)
		}
		return nil, false, rpc.Errorf(rpc.CodeInvalidParams, "%v", err)
	}
	var ls []listed
	for _, de := range ents {
		n := de.Name()
		if hiddenName(n) {
			continue
		}
		e := treeEntry{Kind: "file"}
		switch {
		case de.Type()&os.ModeSymlink != 0:
			e.Kind = "symlink"
			if t, err := os.Readlink(filepath.Join(abs, n)); err == nil {
				e.Target = t
			}
			if st, err := os.Stat(filepath.Join(abs, n)); err == nil {
				e.isDir = st.IsDir()
			}
		case de.IsDir():
			e.Kind, e.isDir = "dir", true
		default:
			if fi, err := de.Info(); err == nil && fi.Mode().IsRegular() {
				sz := fi.Size()
				e.Size = &sz
			}
		}
		e.Name, e.NameRaw = validName(n)
		ls = append(ls, listed{e, n})
	}
	slices.SortStableFunc(ls, func(a, b listed) int {
		switch {
		case entryLess(&a.e, &b.e, a.raw, b.raw):
			return -1
		case entryLess(&b.e, &a.e, b.raw, a.raw):
			return 1
		}
		return 0
	})
	truncated := len(ls) > treeLimit
	if truncated {
		ls = ls[:treeLimit]
	}
	out := make([]treeEntry, len(ls))
	for i, l := range ls {
		e := l.e
		if g != nil {
			p := path.Join(rel, l.raw)
			if g.isIgnored(p) {
				e.Git = "!"
			} else {
				e.Git = g.marks[p]
				e.GitChildren = e.isDir && g.dirs[p]
			}
		}
		out[i] = e
	}
	return out, truncated, nil
}

const gitDirName = ".git"

func hiddenName(n string) bool { return n == gitDirName }

// treeRequest は tree.* と git.status のうち返事のあるもの。
func (ss *session) treeRequest(req *rpc.Message) (res any, err error, handled bool) {
	switch req.Method {
	case "tree.list", "tree.watch", "tree.create", "tree.rename", "tree.delete", "git.status":
	default:
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	var p struct {
		WorkspaceID string   `json:"workspaceId"`
		Path        string   `json:"path"`
		Paths       []string `json:"paths"`
		Kind        string   `json:"kind"`
		From        string   `json:"from"`
		To          string   `json:"to"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err), true
	}
	root, ok := ss.srv.ws.rootOf(p.WorkspaceID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.WorkspaceID), true
	}
	tm := ss.srv.tree
	switch req.Method {
	case "tree.list":
		res, err = tm.list(p.WorkspaceID, root, p.Path)
	case "tree.watch":
		res, err = tm.w.set(p.WorkspaceID, root, p.Paths)
	case "git.status":
		res, err = tm.g.status(p.WorkspaceID, root)
	case "tree.create":
		res, err = tm.create(p.WorkspaceID, root, p.Path, p.Kind)
	case "tree.rename":
		res, err = tm.rename(p.WorkspaceID, root, p.From, p.To)
	case "tree.delete":
		res, err = tm.remove(p.WorkspaceID, root, p.Path)
	}
	return res, err, true
}

func (m *treeManager) list(id, root, p string) (any, error) {
	rel, err := cleanRel(p)
	if err != nil {
		return nil, err
	}
	abs, err := resolveDir(root, rel)
	if err != nil {
		return nil, err
	}
	// 版は読む前に取る。読んでいる間に変わっても、GUI は新しい tree.changed で取り直す。
	rev := m.rev.Load()
	entries, truncated, err := listDir(abs, rel, m.g.state(id, root))
	if err != nil {
		return nil, err
	}
	out := map[string]any{"entries": entries, "rev": rev}
	if truncated {
		out["truncated"] = true
	}
	return out, nil
}

func (m *treeManager) create(id, root, p, kind string) (any, error) {
	if kind != "file" && kind != "dir" {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "kind must be file or dir")
	}
	rel, err := cleanRel(p)
	if err != nil {
		return nil, err
	}
	abs, err := resolveEntry(root, rel)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, fsError(err)
	}
	if kind == "dir" {
		if err := os.Mkdir(abs, 0o755); err != nil {
			return nil, fsError(err)
		}
	} else {
		f, err := os.OpenFile(abs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			return nil, fsError(err)
		}
		f.Close()
	}
	m.changedDirs(id, root, path.Dir(rel))
	return struct{}{}, nil
}

func (m *treeManager) rename(id, root, from, to string) (any, error) {
	fr, err := cleanRel(from)
	if err != nil {
		return nil, err
	}
	tr, err := cleanRel(to)
	if err != nil {
		return nil, err
	}
	fa, err := resolveEntry(root, fr)
	if err != nil {
		return nil, err
	}
	ta, err := resolveEntry(root, tr)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(fa); err != nil {
		return nil, fsError(err)
	}
	// os.Rename は行き先のファイルを黙って消すので、先に確かめる。
	if _, err := os.Lstat(ta); err == nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "already exists: %s", tr)
	}
	if err := os.MkdirAll(filepath.Dir(ta), 0o755); err != nil {
		return nil, fsError(err)
	}
	if err := os.Rename(fa, ta); err != nil {
		return nil, fsError(err)
	}
	m.changedDirs(id, root, path.Dir(fr), path.Dir(tr), fr, tr)
	return struct{}{}, nil
}

func (m *treeManager) remove(id, root, p string) (any, error) {
	rel, err := cleanRel(p)
	if err != nil {
		return nil, err
	}
	abs, err := resolveEntry(root, rel)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(abs); err != nil {
		return nil, fsError(err)
	}
	// シンボリックリンクはリンクだけを消す（先は消さない）。
	if err := os.RemoveAll(abs); err != nil {
		return nil, fsError(err)
	}
	m.changedDirs(id, root, path.Dir(rel), rel)
	return struct{}{}, nil
}

func fsError(err error) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return rpc.Errorf(rpc.CodeNotFound, "%v", err)
	case errors.Is(err, fs.ErrPermission):
		return rpc.Errorf(rpc.CodeDenied, "%v", err)
	case errors.Is(err, fs.ErrExist):
		return rpc.Errorf(rpc.CodeInvalidParams, "already exists: %v", err)
	}
	return rpc.Errorf(rpc.CodeInvalidParams, "%v", err)
}

// changedDirs は変更のあとすぐ、監視しているフォルダの tree.changed を送る（次の巡回を待たない）。
func (m *treeManager) changedDirs(id, root string, rels ...string) {
	m.w.refresh(id, root, rels)
	m.g.refreshAsync(id, root)
}
