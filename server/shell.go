package server

// 窓が決める、ターミナルのシェルと始めるフォルダ（#485）。
//
// 窓は、手元の設定（[[gui.machines]] の start_dir と shell、手元のマシンは [server] の start_dir と shell）をマシンごとに持ち、
// ターミナルを始める要求に付けて渡す。リモートのマシンの設定ファイルは、だれも書き換えない。
//
//   - workspace.create の startDir：dir が無い・使えないときに始めるフォルダ（そのマシンでのパス。~ と ~/x は、そのマシンのホーム）。
//     これも使えなければ、今までどおり [server] start_dir（無ければ ~）。
//   - workspace.create・term.create・term.restart の shell：始めるシェル（実行できるファイルのパス。~/x も書ける。引数は書けない）。
//     使えなければ、別のシェルに替えずに invalid_params で断る（data.reason は "shell"）。窓で選んだ値なので、窓に理由を出せる。
//   - serve は、窓が最後に渡した shell をワークスペースごとに覚える（wsState.shell）。窓を通さずに始まるシェル（止まった serve が
//     作り直すワークスペース、kisui pane split と shj が足す欄）にも、同じシェルを使うため。shell を付けない要求は、覚えているものを
//     使う。空の shell（""）は「このマシンの既定に戻す」で、覚えていたものを忘れる。
//   - 覚えていたシェルが使えなくなっていたら（消された、など）、断らずにこのマシンの既定で始める（ワークスペースを失わないため）。
//
// このマシンの既定は、[server] shell（このマシンの設定ファイル）、無ければ・実行できなければ $SHELL、それも無ければ /bin/sh。
// [server] の start_dir と shell は、使うたびに読み直す（machineDefaults）。手元のマシンでは、窓の設定と同じファイルなので、
// 窓が空（「このマシンの既定」）を渡したときに、起動のときの値でなく、今の設定で決まるようにするため。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/term"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapCreateShell は session.hello の capabilities に入れる、workspace.create の startDir・shell と、term.create・term.restart の
// shell（上の決まり）を受けられる印。古い serve は workspace.create と term.restart の shell を知らずに無視するので、
// 窓はこれを見てから送る。
const CapCreateShell = "workspace.create.shell"

// defaults は、最後に読めた [server] の start_dir と shell（machineDefaults が持つ）。
type defaults struct {
	mu              sync.Mutex
	read            bool // 1 度でも読めたか（読めるまでは、起動のときの Options.StartDir・Shell）
	startDir, shell string
	warned          string // 実行できないと警告した [server] shell（defaultShell）
}

// machineDefaults は、今の設定ファイルの [server] の start_dir と shell（書いていなければ ""）。
// 使うたびに読み直す（Options.ReadDefaults）。serve は長く動き続け、止めるとターミナルが終わるので、起動のときに読んだ値を
// 持ち続けると、設定から消した値が止めるまで残る。読めない・間違いがある間は、最後に読めた値。
func (s *Server) machineDefaults() (startDir, shell string) {
	d := &s.defaults
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.read {
		d.startDir, d.shell = s.opts.StartDir, s.opts.Shell
	}
	if s.opts.ReadDefaults != nil {
		if dir, sh, ok := s.opts.ReadDefaults(); ok {
			d.startDir, d.shell, d.read = dir, sh, true
		}
	}
	return d.startDir, d.shell
}

// defaultShell は、このマシンの既定のシェル。[server] shell が実行できるファイルでなければ（無い、実行の許可が無い）、
// serve を止めずに、ログに警告を出して $SHELL で始める（設定の間違い 1 つで、ターミナルを 1 つも開けなくしないため）。
// 確かめるのは使うたび（ファイルは、設定を読んだあとにも消える・できる）。
func (s *Server) defaultShell() string {
	_, sh := s.machineDefaults()
	if sh == "" {
		return term.DefaultShell()
	}
	path, code := config.ShellPath(sh)
	d := &s.defaults
	d.mu.Lock()
	defer d.mu.Unlock()
	if code == "" {
		d.warned = ""
		return path
	}
	if d.warned != path { // 同じ間違いは 1 度だけ書く（ターミナルを始めるたびに書かない）
		d.warned = path
		s.log.Warn("[server] shell cannot be run; starting $SHELL instead", "shell", path, "instead", term.DefaultShell())
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
// ただし、このマシンの [server] shell と同じファイルなら、断らずにこのマシンの既定（defaultShell：警告を出して $SHELL）。
// 手元のマシンでは、窓が [server] shell をそのまま渡すので、ここで断ると「[server] shell が使えなくても始める」にならない。
func (w *wsManager) checkShell(asked string) (string, *rpc.Error) {
	path, code := config.ShellPath(asked)
	if code == "" {
		return path, nil
	}
	if _, sh := w.srv.machineDefaults(); sh != "" {
		if own, _ := config.ShellPath(sh); own == path {
			return w.srv.defaultShell(), nil
		}
	}
	return "", shellError(path)
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

// shellFor は、要求に付いた shell（asked。nil なら付いていない）から、ワークスペース wsID で始めるシェルを決める。
// 覚えるのは、そのシェルを始められたあと（rememberShell）。
func (w *wsManager) shellFor(wsID string, asked *string) (string, *rpc.Error) {
	if asked == nil {
		return w.rememberedShell(wsID), nil
	}
	if *asked == "" {
		return w.srv.defaultShell(), nil
	}
	return w.checkShell(*asked)
}

// rememberShell は、要求に付いた shell（asked。nil なら何もしない）で始められたあとに、ワークスペース wsID のシェルとして
// 覚え直す（workspaces.json にも書く）。始められなかった要求のシェルは覚えない。recomputeMu を持って呼ぶ。
func (w *wsManager) rememberShell(wsID string, asked *string) {
	if asked == nil {
		return
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
	return append(slices.Clip(env), "SHELL="+sh)
}
