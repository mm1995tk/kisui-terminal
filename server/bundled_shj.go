package server

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// EnvShjDir は、同梱の shj のあるフォルダを手で指す環境変数。GUI が（Nix のパッケージのように
// kisui の隣に shj が無い配り方のときに）渡す。無ければ kisui の実行ファイルと同じフォルダを見る。
const EnvShjDir = "KISUI_SHJ_DIR"

// bundledShjDir は、kisui と一緒に配った shj のあるフォルダ。無ければ空。
//  1. EnvShjDir（shj が実行できるフォルダを指すときだけ）
//  2. kisui の実行ファイル（シンボリックリンクはたどる）と同じフォルダ。AppImage・.app・リモートのキャッシュは
//     kisui の隣に shj を置く。
func bundledShjDir() string {
	if d := os.Getenv(EnvShjDir); d != "" {
		if hasShj(d) {
			return d
		}
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if d := filepath.Dir(exe); hasShj(d) {
		return d
	}
	return ""
}

func hasShj(dir string) bool {
	fi, err := os.Stat(filepath.Join(dir, "shj"))
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}

// withBundledShj は、ターミナルに渡す環境変数 env の PATH の先頭に、同梱の shj のフォルダを足す。
// 同梱の shj が無ければ env のまま。env に PATH があればそれ、無ければ kisui の PATH に足す。
func withBundledShj(env []string) []string {
	dir := bundledShjDir()
	if dir == "" {
		return env
	}
	return prependPath(env, dir)
}

func prependPath(env []string, dir string) []string {
	path := os.Getenv("PATH")
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, "PATH="); ok {
			path = v
		}
	}
	if path == "" {
		path = dir
	} else {
		path = dir + string(os.PathListSeparator) + path
	}
	return append(slices.Clone(env), "PATH="+path)
}
