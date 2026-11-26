package server

// 窓が決める、ターミナルのシェルと始めるフォルダ（#485）。
//
// 新しいターミナルのシェルと始めるフォルダは、もとは serve の動くマシンのもの（$SHELL と [server] start_dir）だけで決まっていた。
// 窓は、手元の設定（[[gui.machines]] の start_dir と shell、手元のマシンは [server] の start_dir と shell）をマシンごとに持ち、
// ターミナルを始める要求に付けて渡す。リモートのマシンの設定ファイルは、だれも書き換えない。
//
//   - workspace.create の startDir：dir が無い・使えないときに始めるフォルダ（そのマシンでのパス。~ と ~/x は、そのマシンのホーム）。
//     これも使えなければ、今までどおり [server] start_dir（無ければ ~）。
//   - workspace.create・term.create・term.restart の shell：始めるシェル（実行できるファイルのパス。~/x も書ける。引数は書けない）。
//     使えなければ、別のシェルに替えずに invalid_params で断る（data.reason は "shell"）。
//   - serve は、窓が最後に渡した shell をワークスペースごとに覚える（wsState.shell）。窓を通さずに始まるシェル（止まった serve が
//     作り直すワークスペース、kisui pane split と shj が足す欄）にも、同じシェルを使うため。shell を付けない要求は、覚えているものを
//     使う。空の shell（""）は「このマシンの既定に戻す」で、覚えていたものを忘れる。
//   - 覚えていたシェルが使えなくなっていたら（消された、など）、断らずにこのマシンの既定で始める（ワークスペースを失わないため）。
//
// このマシンの既定は、[server] shell（このマシンの設定ファイル）、無ければ $SHELL、それも無ければ /bin/sh。

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/term"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapCreateShell は session.hello の capabilities に入れる、workspace.create の startDir・shell と、term.create・term.restart の
// shell（上の決まり）を受けられる印。古い serve は workspace.create と term.restart の shell を知らずに無視するので、
// 窓はこれを見てから送る。
const CapCreateShell = "workspace.create.shell"

// defaultShell は、このマシンの既定のシェル。
func (s *Server) defaultShell() string {
	if s.opts.Shell != "" {
		return s.opts.Shell
	}
	return term.DefaultShell()
}

// shellError は、窓が渡したシェルが使えないときの返事。path は確かめたパス。
func shellError(path string) *rpc.Error {
	e := rpc.Errorf(rpc.CodeInvalidParams, "the shell is not a file that can be run: %s", path)
	e.Data, _ = json.Marshal(map[string]any{"reason": "shell", "shell": path})
	return e
}

// checkShell は、窓が渡した shell（空でない）を確かめる。使えなければ shellError。
func checkShell(asked string) (string, *rpc.Error) {
	path, code := config.ShellPath(asked)
	if code != "" {
		return "", shellError(path)
	}
	return path, nil
}

// usableShell は、覚えていた shell（空なら無し）から、始めるシェルを決める。使えなければ、このマシンの既定。
func (w *wsManager) usableShell(remembered string) string {
	if remembered == "" {
		return w.srv.defaultShell()
	}
	path, code := config.ShellPath(remembered)
	if code != "" {
		w.srv.log.Warn("the shell of the workspace cannot be run; starting the default shell", "shell", path)
		return w.srv.defaultShell()
	}
	return path
}

// rememberedShell は、ワークスペース wsID で、窓を通さずに始めるシェル。
func (w *wsManager) rememberedShell(wsID string) string {
	w.mu.Lock()
	var sh string
	if st := w.reg[wsID]; st != nil {
		sh = st.shell
	}
	w.mu.Unlock()
	return w.usableShell(sh)
}

// shellFor は、要求に付いた shell（asked。nil なら付いていない）から、ワークスペース wsID で始めるシェルを決め、
// 付いていれば覚え直す（workspaces.json にも書く）。recomputeMu を持って呼ぶ。
func (w *wsManager) shellFor(wsID string, asked *string) (string, *rpc.Error) {
	if asked == nil {
		return w.rememberedShell(wsID), nil
	}
	sh := w.srv.defaultShell()
	if *asked != "" {
		var err *rpc.Error
		if sh, err = checkShell(*asked); err != nil {
			return "", err
		}
	}
	w.mu.Lock()
	st := w.reg[wsID]
	changed := st != nil && st.shell != *asked
	if changed {
		st.shell = *asked
	}
	w.mu.Unlock()
	if changed {
		w.persist()
	}
	return sh, nil
}

// usableDir は、窓が渡した startDir（~ と ~/x は、このマシンのホーム）のフォルダ。絶対パスのフォルダでなければ ""。
func usableDir(v string) string {
	if v == "" {
		return ""
	}
	dir, ok := config.ExpandHome(v)
	if !ok || !filepath.IsAbs(dir) {
		return ""
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return ""
	}
	return dir
}

// shellEnv は、シェル sh を始めるときの環境変数。このマシンの $SHELL（無ければ /bin/sh）と違うシェルなら、SHELL をそのシェルにする
// （中で動くプログラムが $SHELL で開くシェルを、設定したシェルに揃える）。
func shellEnv(sh string, env []string) []string {
	if sh == term.DefaultShell() {
		return env
	}
	return append(env[:len(env):len(env)], "SHELL="+sh)
}
