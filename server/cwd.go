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
)

// findRoot は cwd から親へたどってワークスペースのルートを決める。
// `.git`（フォルダでもファイルでもよい）か `.shijimi-editor/` がある最初のフォルダがルート。
// 無ければ cwd そのもの（kind "cwd"）。cwd が home か / なら ok == false（ワークスペースにしない）。
// たどる途中で home や / に着いても、そこはルートにしない。
func findRoot(cwd, home string) (root, kind string, ok bool) {
	cwd = filepath.Clean(cwd)
	if !filepath.IsAbs(cwd) || isHomeOrSlash(cwd, home) {
		return "", "", false
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
	dot := filepath.Join(root, ".git")
	gitDir := dot
	if fi, err := os.Stat(dot); err != nil {
		return ""
	} else if !fi.IsDir() {
		// git worktree / submodule: "gitdir: <path>"
		b, err := os.ReadFile(dot)
		if err != nil {
			return ""
		}
		rest, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
		if !ok {
			return ""
		}
		gitDir = strings.TrimSpace(rest)
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(root, gitDir)
		}
	}
	b, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(b))
	if ref, ok := strings.CutPrefix(s, "ref: refs/heads/"); ok {
		return ref
	}
	if ref, ok := strings.CutPrefix(s, "ref: "); ok {
		return ref
	}
	if len(s) >= 7 {
		return s[:7]
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
