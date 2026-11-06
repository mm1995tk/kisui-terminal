package server

import (
	"embed"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// envShjPathDir は、起動ファイルの包みに「同梱の shj のフォルダ」を渡す環境変数。
const envShjPathDir = "KISUI_SHJ_PATH_DIR"

// envOrigZDOTDIR は、zsh の元の ZDOTDIR（未設定なら空）。ZDOTDIR を kisui の包みに向けるので、元の値を預ける。
const envOrigZDOTDIR = "KISUI_ORIG_ZDOTDIR"

//go:embed shellinit
var shellInit embed.FS

// bundledShell は、ターミナルで起動するシェル sh の引数と環境変数を返す。
//
// 同梱の shj のフォルダを PATH の先頭に足す（prependPath）だけでは、シェルの起動ファイル
// （.zshrc・.zprofile・path_helper など）がそのあと PATH を組み直して、別の shj が先になることがある。
// そこで zsh・bash・fish は、ユーザーの起動ファイルを全部読んだあとで同梱の shj のフォルダを
// PATH の先頭に入れ直すように包んで起動する（kitty や Ghostty の shell integration と同じやり方）。
// ユーザーの起動ファイルは書き換えず、今まで通り読まれる。
// 同梱の shj が無いときは env のまま。対応しないシェルや、包みを書き出せないときは、PATH に足すだけ。
func bundledShell(sh string, env []string) (args, outEnv []string) {
	dir := bundledShjDir()
	if dir == "" {
		return nil, env
	}
	env = prependPath(env, dir)
	withDir := append(slices.Clone(env), envShjPathDir+"="+dir) // 包みが使う

	switch filepath.Base(sh) {
	case "zsh":
		root, err := writeShellInit()
		if err != nil {
			return nil, env
		}
		env = withDir
		// 元の ZDOTDIR を預け、ZDOTDIR を kisui の包みに向ける。包みが元の ZDOTDIR の起動ファイルを読む。
		return nil, append(env, envOrigZDOTDIR+"="+lookupEnv(env, "ZDOTDIR"), "ZDOTDIR="+filepath.Join(root, "zsh"))
	case "bash":
		root, err := writeShellInit()
		if err != nil {
			return nil, env
		}
		env = withDir
		return []string{"--rcfile", filepath.Join(root, "bash", "bashrc")}, env
	case "fish":
		// -C は config.fish を読んだあとに実行される
		return []string{"-C", `set -gx PATH $` + envShjPathDir + ` (string match -v -- $` + envShjPathDir + ` $PATH)`}, withDir
	}
	return nil, env
}

// lookupEnv は、シェルが受け取る環境変数（kisui の環境に env を重ねたもの）の key の値。無ければ空。
func lookupEnv(env []string, key string) string {
	v := os.Getenv(key)
	for _, e := range env {
		if x, ok := strings.CutPrefix(e, key+"="); ok {
			v = x
		}
	}
	return v
}

// 書き出すファイル（embed 上の名前 -> 書き出し先）。embed はドットで始まるファイルを含められないので、名前を変える。
var shellInitFiles = map[string]string{
	"shellinit/zsh/zshenv":   "zsh/.zshenv",
	"shellinit/zsh/zprofile": "zsh/.zprofile",
	"shellinit/zsh/zshrc":    "zsh/.zshrc",
	"shellinit/zsh/zlogin":   "zsh/.zlogin",
	"shellinit/zsh/zlogout":  "zsh/.zlogout",
	"shellinit/bash/bashrc":  "bash/bashrc",
}

// writeShellInit は、起動ファイルの包みをユーザーのキャッシュのフォルダに書き出して、そのフォルダを返す。
// 中身が同じなら書き直さない。kisui が同時に何個動いても壊れないよう、一時ファイルに書いて置き換える。
func writeShellInit() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	root := filepath.Join(base, "kisui-terminal", "shell-integration")
	for src, dst := range shellInitFiles {
		data, err := fs.ReadFile(shellInit, src)
		if err != nil {
			return "", err
		}
		path := filepath.Join(root, dst)
		if cur, err := os.ReadFile(path); err == nil && string(cur) == string(data) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", err
		}
		tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
		if err != nil {
			return "", err
		}
		_, werr := tmp.Write(data)
		cerr := tmp.Close()
		if err := errors.Join(werr, cerr); err != nil {
			os.Remove(tmp.Name())
			return "", err
		}
		if err := os.Rename(tmp.Name(), path); err != nil {
			os.Remove(tmp.Name())
			return "", err
		}
	}
	return root, nil
}
