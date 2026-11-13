package server

// ワークスペースのルート探しと、シェルの cwd の取得。設計は docs/design/gui-protocol.md の「ワークスペース」。

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// findRoot は cwd から親へたどってワークスペースのルートを決める。
// `.git`（フォルダでもファイルでもよい）か `.shijimi-editor/` がある最初のフォルダがルート。
// 無ければ cwd そのもの（kind "cwd"）。cwd が home か / そのものなら、目印は探さず cwd そのもの（kind "cwd"）。
// たどる途中で home や / に着いても、そこはルートにしない（home に .git があっても、~/memo のルートは ~ にならない）。
// ok == false になるのは、cwd が絶対パスでないときだけ。
func findRoot(cwd, home string) (root, kind string, ok bool) {
	cwd = filepath.Clean(cwd)
	if !filepath.IsAbs(cwd) {
		return "", "", false
	}
	if isHomeOrSlash(cwd, home) {
		return cwd, "cwd", true
	}
	for d := cwd; !isHomeOrSlash(d, home); d = filepath.Dir(d) {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return d, "git", true
		}
		if fi, err := os.Stat(filepath.Join(d, ".shijimi-editor")); err == nil && fi.IsDir() {
			return d, "shijimi", true
		}
	}
	return cwd, "cwd", true
}

func isHomeOrSlash(p, home string) bool {
	return p == "/" || (home != "" && p == home)
}

// normalizePath はシンボリックリンクをたどった絶対パスにする。できなければ Clean しただけ。
func normalizePath(p string) string {
	p = filepath.Clean(p)
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

// workspaceID はルートのパス（正規化済み）から作る。
func workspaceID(root string) string {
	h := sha256.Sum256([]byte(root))
	return "w" + hex.EncodeToString(h[:6])
}

// gitBranch は root の .git から今のブランチ名を読む（git は呼ばない）。
// detached HEAD なら先頭 7 文字のコミット。分からなければ ""。
func gitBranch(root string) string {
	branch, sha, ok := gitHead(root)
	if !ok {
		return ""
	}
	if branch == "" {
		return sha
	}
	return branch
}

// shortSHALen は帯に出す short sha の長さ。
const shortSHALen = 7

// gitHead は root の .git から、今のブランチ名と HEAD のコミット（先頭 shortSHALen 文字）を読む（git は呼ばない）。
// detached HEAD なら branch は ""。コミットがまだ無いブランチなど、sha が分からないときは ""。
// ok は .git が読めたか。
func gitHead(root string) (branch, sha string, ok bool) {
	dot := filepath.Join(root, ".git")
	gitDir := dot
	if fi, err := os.Stat(dot); err != nil {
		return "", "", false
	} else if !fi.IsDir() {
		// git worktree / submodule: "gitdir: <path>"
		b, err := os.ReadFile(dot)
		if err != nil {
			return "", "", false
		}
		rest, found := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
		if !found {
			return "", "", false
		}
		gitDir = strings.TrimSpace(rest)
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(root, gitDir)
		}
	}
	b, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return "", "", false
	}
	s := strings.TrimSpace(string(b))
	ref, symbolic := strings.CutPrefix(s, "ref:")
	if !symbolic {
		return "", shortSHA(s), true
	}
	ref = strings.TrimSpace(ref)
	branch = strings.TrimPrefix(ref, "refs/heads/")
	return branch, shortSHA(readRef(gitDir, ref)), true
}

// readRef は ref（refs/heads/main など）が指すコミットを読む。ref のファイル、無ければ packed-refs。
// worktree では ref と packed-refs は gitDir ではなく共通の .git（commondir）にある。分からなければ ""。
func readRef(gitDir, ref string) string {
	dirs := []string{gitDir}
	if b, err := os.ReadFile(filepath.Join(gitDir, "commondir")); err == nil {
		c := strings.TrimSpace(string(b))
		if !filepath.IsAbs(c) {
			c = filepath.Join(gitDir, c)
		}
		dirs = append(dirs, c)
	}
	for _, d := range dirs {
		if b, err := os.ReadFile(filepath.Join(d, filepath.FromSlash(ref))); err == nil {
			if s := strings.TrimSpace(string(b)); s != "" {
				return s
			}
		}
	}
	for _, d := range dirs {
		if sha := packedRef(filepath.Join(d, "packed-refs"), ref); sha != "" {
			return sha
		}
	}
	return ""
}

// packedRefsCache は packed-refs を読んだ結果（ref -> コミット）を、ファイルの mtime と大きさが変わるまで取っておく。
// buildWorkspaces は 1 秒ごとに呼ばれ、packed-refs は大きいことがあるため。
var packedRefsCache struct {
	sync.Mutex
	by map[string]packedRefs
}

type packedRefs struct {
	mod  time.Time
	size int64
	refs map[string]string
}

// packedRef は packed-refs の file から ref のコミットを探す。無ければ ""。
func packedRef(file, ref string) string {
	fi, err := os.Stat(file)
	if err != nil {
		return ""
	}
	packedRefsCache.Lock()
	defer packedRefsCache.Unlock()
	if c, ok := packedRefsCache.by[file]; ok && c.mod.Equal(fi.ModTime()) && c.size == fi.Size() {
		return c.refs[ref]
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	refs := map[string]string{}
	for l := range strings.SplitSeq(string(b), "\n") {
		// "<sha> <ref>"。"#" 始まり（ヘッダ）と "^" 始まり（タグの指す先）は読まない。
		if sha, name, ok := strings.Cut(strings.TrimSpace(l), " "); ok && !strings.HasPrefix(sha, "#") && !strings.HasPrefix(sha, "^") {
			refs[name] = sha
		}
	}
	if packedRefsCache.by == nil {
		packedRefsCache.by = map[string]packedRefs{}
	}
	packedRefsCache.by[file] = packedRefs{fi.ModTime(), fi.Size(), refs}
	return refs[ref]
}

func shortSHA(s string) string {
	if len(s) > shortSHALen {
		return s[:shortSHALen]
	}
	return s
}

// lsofCwd は lsof でプロセスの cwd を読む（macOS で proc_info が使えないときの代わり）。
func lsofCwd(pid int) (string, error) {
	out, err := exec.Command("lsof", "-a", "-d", "cwd", "-Fn", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", err
	}
	for l := range strings.SplitSeq(string(out), "\n") {
		if p, ok := strings.CutPrefix(l, "n"); ok && p != "" {
			return p, nil
		}
	}
	return "", os.ErrNotExist
}
