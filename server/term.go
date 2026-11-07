package server

// ターミナル管理と term.*。設計は docs/design/gui-protocol.md の 3 章「ターミナル」。
//
// PTY の出力は Screen に変換せず、そのまま term.output で流す（ui/tui/vt は使わない）。
// 出力は 1 ターミナルにつき最大 1 MiB のリングバッファに溜め、seq はそのバイト数の累計。
// GUI が term.ack で返した seq から 256 KiB より先は送らない。止まっても PTY は読み続け、
// 溢れた分は捨てる。リングバッファは、この送り出し（ack の窓）のためだけに持つ。
//
// GUI が取り直す（つなぎ直し・溢れて欠けた）ときは、過去のバイト列は流さず、欄ごとの画面の状態
// （screen.go の coneko-term）の書き出しを term.attach で返す。過去の出力に入っている端末への問い合わせ
// （DECRQM など）を GUI の coneko-term がもう一度受けて、シェルへ返事を打ち込むことが無いように。
//
// command-end（OSC 133;D）の印はサーバーでは取り出さない。理由は docs/design/gui-protocol.md の「ターミナル」を見る。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/creack/pty"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/internal/term"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

const (
	ringSize   = 1 << 20   // 1 ターミナルにつき溜めておく出力
	ackWindow  = 256 << 10 // ack 済みの seq から先へ送ってよい量
	chunkSize  = 32 << 10  // term.output 1 通の最大
	maxTermDim = 1 << 12
	maxTitle   = 256

	// snapshotScrollback は term.attach の書き出しに入れる scrollback の行数（GUI の coneko-term の scrollback と同じ）。
	snapshotScrollback = 5000
)

// termManager はサーバー全体のターミナル。
// command-end（OSC 133;D）をサーバーで取り出さない理由は docs/design/gui-protocol.md の「ターミナル」を見る。
type termManager struct {
	srv    *Server
	mu     sync.Mutex
	next   int
	terms  map[string]*terminal
	wg     sync.WaitGroup
	closed bool
}

func newTermManager(s *Server) *termManager {
	return &termManager{srv: s, terms: map[string]*terminal{}}
}

// all は今あるターミナルを返す。
func (m *termManager) all() []*terminal {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*terminal, 0, len(m.terms))
	for _, t := range m.terms {
		out = append(out, t)
	}
	return out
}

func (m *termManager) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.terms)
}

// shutdown は全部のシェルに SIGHUP を送り、終わるのを待つ。
func (m *termManager) shutdown() {
	m.mu.Lock()
	m.closed = true
	var all []*terminal
	for _, t := range m.terms {
		all = append(all, t)
	}
	m.mu.Unlock()
	for _, t := range all {
		t.hangup()
	}
	m.wg.Wait()
}

type terminal struct {
	mgr  *termManager
	id   string
	pid  int
	ptmx *os.File
	cmd  *exec.Cmd // このサーバーが始めたシェル。引き継いだシェル（子ではない）は nil
	// process はシェルに合図を送る先。始めたシェルは cmd.Process、引き継いだシェルは pid から引いたもの。
	process *os.Process

	// sendMu は term.output の送り出しと term.attach を 1 つずつにする（順序と二重送りを防ぐ）。
	sendMu sync.Mutex

	mu         sync.Mutex
	cwd        string // シェルの今の cwd（workspace.go が更新）
	wsID       string // 属するワークスペース（作るときに決まり、cwd が変わっても変わらない）
	primary    bool   // ワークスペースのプライマリターミナル
	cols, rows int
	title      string
	alive      bool
	ring       []byte // 循環バッファ。直近 ringSize バイトが入っている
	total      int64  // これまでに読んだバイト数（seq）
	sent       int64  // ここまで送った
	acked      int64  // GUI が処理したと言ったところ
	osc        oscScan
	feed       *screenFeed // 画面の状態を持つ coneko-term（screen.go）。term.attach はこの書き出しを返す
	base       int64       // リングに入っている一番古い seq の下限（引き継いだときは、受け取ったリングの先頭）

	pumpDone chan struct{} // 今の pump が終わると閉じる。pump が無ければ nil（mu で守る）
	pause    pauser        // 引き継ぎ（handover.go）のために pump を止める
}

// ringBytes は seq が [from, to) の範囲のバイト列を返す。from が捨てられた分なら残っている先頭から。
// mu を持って呼ぶ。
func (t *terminal) ringBytes(from, to int64) (int64, []byte) {
	oldest := t.oldest()
	from = max(from, oldest)
	to = min(to, t.total)
	if from >= to {
		return max(from, to), nil
	}
	out := make([]byte, to-from)
	pos := int(from % ringSize)
	n := copy(out, t.ring[pos:])
	copy(out[n:], t.ring)
	return from, out
}

// oldest はリングに残っている一番古い seq。mu を持って呼ぶ。
func (t *terminal) oldest() int64 { return max(t.base, t.total-ringSize) }

// ringAppend は mu を持って呼ぶ。ring は常に ringSize バイトの循環バッファで、seq s は ring[s%ringSize] に入る。
func (t *terminal) ringAppend(b []byte) {
	for len(b) > 0 {
		n := copy(t.ring[t.total%ringSize:], b)
		t.total += int64(n)
		b = b[n:]
	}
}

func (t *terminal) info() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{
		"termId": t.id, "pid": t.pid, "cwd": t.cwd, "workspaceId": t.wsID, "primary": t.primary,
		"title": t.title, "cols": t.cols, "rows": t.rows, "alive": t.alive,
	}
}

// proc は今のシェルの PTY とプロセス。term.restart で入れ替わる。
func (t *terminal) proc() (*os.File, *os.Process) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ptmx, t.process
}

func (t *terminal) hangup() {
	t.feed.close() // ターミナルを忘れるときに呼ばれる。以後の出力は画面の状態に入れない
	ptmx, p := t.proc()
	// SIGHUP を無視するシェルで shutdown が止まらないように、少し待って SIGKILL。
	if p != nil {
		time.AfterFunc(3*time.Second, func() { _ = p.Kill() })
		_ = p.Signal(syscall.SIGHUP)
	}
	// ptmx を閉じても SIGHUP が届く。シェルが SIGHUP を無視しても pump は read の失敗で終わる。
	ptmx.Close()
}

// busy は、シェルのほかにプログラムが前面で動いているか。PTY の前面のプロセスグループが、
// シェルのもの（シェルは自分の pid のグループを作る）と違えば動いている。
func (t *terminal) busy() bool {
	t.mu.Lock()
	alive, pid, ptmx := t.alive, t.pid, t.ptmx
	t.mu.Unlock()
	if !alive {
		return false
	}
	rc, err := ptmx.SyscallConn()
	if err != nil {
		return false
	}
	var pgrp int32
	var errno syscall.Errno
	// Fd() は PTY を blocking にして読みを止められなくするので使わない。
	if err := rc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, uintptr(syscall.TIOCGPGRP), uintptr(unsafe.Pointer(&pgrp)))
	}); err != nil || errno != 0 {
		return false
	}
	return pgrp != 0 && int(pgrp) != pid
}

// termStart は新しいターミナルの始め方。
type termStart struct {
	cols, rows int
	dir        string // 始めるフォルダ
	shell      string
	env        []string
	wsID       string
	primary    bool
}

// start はシェルを始めてターミナルを足す。ワークスペースの一覧は作り直さない（呼ぶ側がする）。
func (m *termManager) start(a termStart) (*terminal, error) {
	if fi, err := os.Stat(a.dir); err != nil || !fi.IsDir() {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "cwd is not a directory: %s", a.dir)
	}
	sh := a.shell
	if sh == "" {
		sh = term.DefaultShell()
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, rpc.Errorf(rpc.CodeBusy, "server is shutting down")
	}
	env := a.env
	if a.primary {
		// 起動する shj が自分で名乗れるように、プライマリにだけ渡す。ターミナルの id はこの下で振る番号。
		env = append(slices.Clone(env), ctl.EnvGUIPrimary+"="+fmt.Sprintf("t%d", m.next+1))
	}
	if a.wsID != "" {
		// 同じワークスペースのどのターミナルからも、プライマリの shj に届くように（ctl.GUILinkPath）。
		env = append(slices.Clone(env), ctl.EnvGUIWorkspace+"="+a.wsID)
	}
	// PTY の起動は ui/internal/term と同じ（TUI のターミナルも使う）。読み出しと流量制御はここで持つ。
	// 欄の中の shj は、kisui と一緒に配った shj を先に使う（PATH の先頭に足し、起動ファイルのあとにも入れ直す）
	args, env := bundledShell(sh, env)
	sess, err := term.Start(term.Options{Shell: sh, Args: args, Dir: a.dir, Env: env, Cols: a.cols, Rows: a.rows})
	if err != nil {
		m.mu.Unlock()
		return nil, rpc.Errorf(rpc.CodeInternalError, "start shell: %v", err)
	}
	ptmx, cmd := pollable(sess.File(), m.srv.log), sess.Cmd()
	m.next++
	t := &terminal{
		mgr: m, id: fmt.Sprintf("t%d", m.next), pid: sess.Pid(),
		ptmx: ptmx, cmd: cmd, process: cmd.Process, cols: a.cols, rows: a.rows, alive: true,
		ring: make([]byte, ringSize), wsID: a.wsID, primary: a.primary,
		feed: newScreenFeed(m.srv.log, a.rows, a.cols),
	}
	t.cwd = normalizePath(a.dir) // 以後 cwd の変化を見るので、読み取った値（実パス）に合わせる
	m.terms[t.id] = t
	t.startPump()
	m.mu.Unlock()
	m.srv.log.Info("term created", "termId", t.id, "pid", t.pid, "shell", sh, "cwd", a.dir, "workspace", a.wsID, "primary", a.primary)
	return t, nil
}

// create は term.create。分割したターミナルを足す。
func (m *termManager) create(p termCreateParams) (any, error) {
	if p.Cols <= 0 || p.Rows <= 0 || p.Cols > maxTermDim || p.Rows > maxTermDim {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "cols and rows must be 1..%d", maxTermDim)
	}
	var env []string
	for k, v := range p.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid env name: %q", k)
		}
		env = append(env, k+"="+v)
	}
	dir, ok := m.srv.ws.folderOf(p.WorkspaceID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.WorkspaceID)
	}
	// 上限の数え方と作るのを、recompute と同じロックで 1 つずつにする（同時に作って 6 個を超えない）。
	m.srv.ws.recomputeMu.Lock()
	defer m.srv.ws.recomputeMu.Unlock()
	if m.srv.ws.cellsFree(p.WorkspaceID) <= 0 {
		return nil, rpc.Errorf(rpc.CodeBusy, "the workspace already has %d terminals", maxSplitTerms+1)
	}
	t, err := m.start(termStart{cols: p.Cols, rows: p.Rows, dir: dir, shell: p.Shell, env: env, wsID: p.WorkspaceID})
	if err != nil {
		return nil, err
	}
	m.srv.ws.recomputeLocked()
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{"termId": t.id, "pid": t.pid, "cwd": t.cwd}, nil
}

// countSplit はワークスペースの分割したターミナルの数。
func (m *termManager) countSplit(wsID string) int {
	n := 0
	for _, t := range m.all() {
		t.mu.Lock()
		if t.wsID == wsID && !t.primary {
			n++
		}
		t.mu.Unlock()
	}
	return n
}

// closeWorkspace はワークスペースのターミナル（プライマリと分割）を全部終わらせて忘れる。
func (m *termManager) closeWorkspace(wsID string) {
	m.mu.Lock()
	var mine []*terminal
	for id, t := range m.terms {
		t.mu.Lock()
		own := t.wsID == wsID
		t.mu.Unlock()
		if own {
			mine = append(mine, t)
			delete(m.terms, id)
		}
	}
	m.mu.Unlock()
	for _, t := range mine {
		t.hangup()
		t.mu.Lock()
		t.alive = false
		t.mu.Unlock()
	}
}

// restart は終わったプライマリターミナルに新しいシェルを始める（termId はそのまま）。
func (m *termManager) restart(t *terminal) (any, error) {
	t.mu.Lock()
	primary, alive, wsID, cols, rows := t.primary, t.alive, t.wsID, t.cols, t.rows
	t.mu.Unlock()
	if !primary {
		return nil, rpc.Errorf(rpc.CodeDenied, "only a primary terminal can be restarted: %s", t.id)
	}
	if alive {
		return nil, rpc.Errorf(rpc.CodeBusy, "the shell is still running: %s", t.id)
	}
	dir, ok := m.srv.ws.folderOf(wsID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", wsID)
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		// フォルダが無くなっていたら、start_dir（それも無ければ ~）で始める。
		dir = m.srv.ws.startDir()
	}
	m.mu.Lock()
	if m.closed || m.terms[t.id] != t {
		m.mu.Unlock()
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such terminal: %s", t.id)
	}
	sh := term.DefaultShell()
	args, env := bundledShell(sh, []string{ctl.EnvGUIPrimary + "=" + t.id, ctl.EnvGUIWorkspace + "=" + wsID})
	sess, err := term.Start(term.Options{Shell: sh, Args: args, Dir: dir, Env: env, Cols: cols, Rows: rows})
	if err != nil {
		m.mu.Unlock()
		return nil, rpc.Errorf(rpc.CodeInternalError, "start shell: %v", err)
	}
	ptmx, cmd := pollable(sess.File(), m.srv.log), sess.Cmd()
	t.mu.Lock()
	t.ptmx, t.cmd, t.process, t.pid, t.alive = ptmx, cmd, cmd.Process, sess.Pid(), true
	t.cwd = normalizePath(dir)
	t.osc = oscScan{}
	cwd, pid := t.cwd, t.pid
	t.mu.Unlock()
	t.startPump()
	m.mu.Unlock()
	m.srv.log.Info("term restarted", "termId", t.id, "pid", pid, "cwd", dir)
	return map[string]any{"pid": pid, "cwd": cwd}, nil
}

func (m *termManager) get(id string) (*terminal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.terms[id]
	if t == nil {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such terminal: %s", id)
	}
	return t, nil
}

// startPump は今の PTY を読む pump を始める。m.mu を持って呼ぶ（shutdown の Wait より前に Add するため）。
func (t *terminal) startPump() {
	t.mu.Lock()
	ptmx, cmd, p := t.ptmx, t.cmd, t.process
	done := make(chan struct{})
	t.pumpDone = done
	t.mu.Unlock()
	t.mgr.wg.Go(func() {
		defer close(done)
		t.pump(ptmx, cmd, p)
	})
}

// pump は PTY を読み続けてリングバッファに溜め、送れるなら送る。止まった GUI には送らないが読むのはやめない。
// 引き継ぎ（handover.go）のときは、読みの期限を過去にされて止まり（park）、止めるのをやめたら読み直す。
func (t *terminal) pump(ptmx *os.File, cmd *exec.Cmd, p *os.Process) {
	buf := make([]byte, chunkSize)
	for {
		n, err := ptmx.Read(buf)
		if n > 0 {
			t.mu.Lock()
			t.ringAppend(buf[:n])
			t.feed.write(buf[:n]) // ring の seq と画面の状態の位置を合わせるため、同じロックの中で渡す（待たない）
			title, changed := t.osc.feed(buf[:n])
			if changed {
				t.title = title
			}
			t.mu.Unlock()
			if changed {
				t.mgr.srv.notifyOwner("term.title", map[string]any{"termId": t.id, "title": title})
			}
			t.flush()
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				t.pause.park()
				continue
			}
			break
		}
	}
	exit := map[string]any{"termId": t.id}
	if cmd != nil {
		_ = cmd.Wait()
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			exit["code"] = 128 + int(ws.Signal())
			exit["signal"] = ws.Signal().String()
		} else {
			exit["code"] = cmd.ProcessState.ExitCode()
		}
	} else {
		// 引き継いだシェルはこのサーバーの子ではないので、終了コードは分からない（code を省く）。
		// PTY が閉じた（シェルとその子が端末を手放した）あと、プロセスが無くなるのを待つ。
		waitGone(p)
	}
	ptmx.Close()
	t.mu.Lock()
	t.alive = false
	if t.process == p {
		// 終わったシェルには、もう合図を送らない（hangup）。引き継いだシェルの os.Process は、pidfd の無い
		// macOS では終わったことを覚えないので、残すと使い回された pid の別のプロセスに SIGHUP・SIGKILL が届く。
		t.process = nil
	}
	t.mu.Unlock()
	t.flush() // 最後の出力が先に届くように
	t.mgr.srv.notifyOwner("term.exit", exit)
	t.mgr.srv.ws.recompute()
	t.mgr.srv.log.Info("term exited", "termId", t.id, "code", exit["code"])
}

// setWinsize は PTY の大きさを変える。pty.Setsize は Fd() で master を blocking にするので使わない。
func setWinsize(f *os.File, cols, rows int) error {
	if f == nil {
		return os.ErrInvalid
	}
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	ws := pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
	var errno syscall.Errno
	if err := rc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, uintptr(syscall.TIOCSWINSZ), uintptr(unsafe.Pointer(&ws)))
	}); err != nil {
		return err
	}
	if errno != 0 {
		return errno
	}
	return nil
}

// waitGone は p が無くなる（終わって刈り取られる）まで待つ。p が nil なら待たない。
func waitGone(p *os.Process) {
	if p == nil {
		return
	}
	for d := 10 * time.Millisecond; ; d = min(d*2, time.Second) {
		if err := p.Signal(syscall.Signal(0)); err != nil {
			return
		}
		time.Sleep(d)
	}
}

// pollable は PTY の master を、読みの期限（SetReadDeadline）で読みを止められるものにして返す。引き継ぎで pump を
// 止めるのに使う。creack/pty は ioctl のたびに Fd() を呼んで master を blocking にする（macOS では初めから blocking の
// fd を包む）ので、dup して O_NONBLOCK にしたものを包み直す。以後この master には Fd() を呼ばない（setWinsize を使う）。
// 包み直せなければ元のまま返す（読みは止められないので、そのターミナルがあると引き継ぎは断る）。
func pollable(f *os.File, log *slog.Logger) *os.File {
	rc, err := f.SyscallConn()
	if err != nil {
		return f
	}
	nfd := -1
	_ = rc.Control(func(fd uintptr) {
		syscall.ForkLock.RLock()
		defer syscall.ForkLock.RUnlock()
		if d, err := syscall.Dup(int(fd)); err == nil {
			syscall.CloseOnExec(d)
			nfd = d
		}
	})
	if nfd < 0 {
		return f
	}
	if err := syscall.SetNonblock(nfd, true); err != nil {
		syscall.Close(nfd)
		return f
	}
	nf := os.NewFile(uintptr(nfd), f.Name())
	if err := nf.SetReadDeadline(time.Time{}); err != nil {
		log.Warn("pty does not take deadlines; handover is not possible", "err", err)
		// O_NONBLOCK は f と共有なので、blocking に戻してから閉じる（f の読みが EAGAIN で終わらないように）
		_ = syscall.SetNonblock(nfd, false)
		nf.Close()
		return f
	}
	f.Close()
	return nf
}

// flush は送ってよい分（ack から 256 KiB まで）を term.output にして owner に送る。
func (t *terminal) flush() {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	for {
		t.mu.Lock()
		// 窓は ack 済みか、リングに残っている先頭のどちらか進んだ方から数える。溢れて捨てられた分は
		// GUI が受け取れず ack も進められないので、ack だけを基準にすると永久に止まる。
		// 捨てられた分は seq が飛んで届くので、GUI は欠けを知って term.attach で取り直せる。
		base := max(t.acked, t.oldest())
		from, data := t.ringBytes(t.sent, min(t.total, base+ackWindow, t.sent+chunkSize))
		// 溢れて捨てられた分は送れないので、送った扱いにして先へ進む。
		if len(data) == 0 {
			t.sent = max(t.sent, from)
			t.mu.Unlock()
			return
		}
		seq := from + int64(len(data))
		id := t.id
		t.mu.Unlock()
		if !t.mgr.srv.notifyOwner("term.output", map[string]any{
			"termId": id, "seq": seq, "data": base64.StdEncoding.EncodeToString(data),
		}) {
			return // つながっている GUI がいない。溜めたままにして、attach で取り直してもらう。
		}
		t.mu.Lock()
		t.sent = seq
		t.mu.Unlock()
	}
}

func (t *terminal) ack(seq int64) {
	t.mu.Lock()
	if seq > t.acked && seq <= t.total {
		t.acked = seq
	}
	t.mu.Unlock()
	t.flush()
}

// attach は term.attach。画面の状態の書き出しと、その時点の seq を返す。書き出しは、seq までの出力を全部
// 反映した画面で、GUI は reset してから書き、seq より先の term.output を続ける。
//
// seq の位置は、pump が ring と画面の状態へ同じロックの中で出力を渡すので、ここで t.total を読んで書き出しを頼めば
// 一致する。書き出しができるのを待つ間は、ロックを持たない（PTY の読みと term.output を止めない）。
// seq より先の term.output は、返事より先に GUI に届くことがある（GUI が取っておく）。
func (t *terminal) attach() (any, error) {
	t.sendMu.Lock()
	t.mu.Lock()
	res := t.feed.snapshot(snapshotScrollback)
	seq, cols, rows := t.total, t.cols, t.rows
	// seq までは書き出しに入っているので、GUI が受け取ったことになる。ここから先を流す。
	t.sent, t.acked = seq, seq
	t.mu.Unlock()
	t.sendMu.Unlock()
	r := <-res
	if r.err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "screen snapshot: %v", r.err)
	}
	return map[string]any{
		"seq": seq, "snapshot": base64.StdEncoding.EncodeToString(r.data), "cols": cols, "rows": rows,
	}, nil
}

type termCreateParams struct {
	WorkspaceID string            `json:"workspaceId"`
	Cols        int               `json:"cols"`
	Rows        int               `json:"rows"`
	Shell       string            `json:"shell"`
	Env         map[string]string `json:"env"`
}

// notifyOwner は今の GUI に通知を送る。送れたら true。
func (s *Server) notifyOwner(method string, params any) bool {
	s.mu.Lock()
	o := s.owner
	s.mu.Unlock()
	if o == nil {
		return false
	}
	return o.conn.Notify(method, params) == nil
}

// termRequest は term.* のうち返事のあるもの。扱わないメソッドは handled == false。
func (ss *session) termRequest(req *rpc.Message) (res any, err error, handled bool) {
	m := ss.srv.terms
	switch req.Method {
	case "term.create", "term.list", "term.attach", "term.close", "term.restart", "term.resize", "term.input", "term.cd":
	default:
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	switch req.Method {
	case "term.create":
		var p termCreateParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err), true
		}
		res, err = m.create(p)
		return res, err, true
	case "term.list":
		m.mu.Lock()
		all := make([]*terminal, 0, len(m.terms))
		for _, t := range m.terms {
			all = append(all, t)
		}
		m.mu.Unlock()
		list := make([]map[string]any, 0, len(all))
		for _, t := range all {
			list = append(list, t.info())
		}
		sortTerms(list)
		return map[string]any{"terms": list}, nil, true
	}
	var p struct {
		TermID string  `json:"termId"`
		Cols   int     `json:"cols"`
		Rows   int     `json:"rows"`
		Data   string  `json:"data"`
		Path   *string `json:"path"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err), true
	}
	t, err := m.get(p.TermID)
	if err != nil {
		return nil, err, true
	}
	switch req.Method {
	case "term.attach":
		res, err = t.attach()
		return res, err, true
	case "term.restart":
		res, err = m.restart(t)
		return res, err, true
	case "term.close":
		t.mu.Lock()
		primary := t.primary
		t.mu.Unlock()
		if primary {
			return nil, rpc.Errorf(rpc.CodeDenied, "a primary terminal is closed with its workspace (workspace.close): %s", t.id), true
		}
		m.closeTerm(t.id)
		ss.srv.ws.recompute()
		return struct{}{}, nil, true
	case "term.resize":
		if p.Cols <= 0 || p.Rows <= 0 || p.Cols > maxTermDim || p.Rows > maxTermDim {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "cols and rows must be 1..%d", maxTermDim), true
		}
		ptmx, _ := t.proc()
		if err := setWinsize(ptmx, p.Cols, p.Rows); err != nil {
			return nil, rpc.Errorf(rpc.CodeNotFound, "terminal has exited: %s", t.id), true
		}
		t.mu.Lock()
		t.cols, t.rows = p.Cols, p.Rows
		t.feed.resize(p.Rows, p.Cols) // attach が返す cols・rows と書き出しの大きさをそろえるため、同じロックの中で渡す
		t.mu.Unlock()
		return struct{}{}, nil, true
	case "term.cd":
		// 制御文字（行の編集や端末の行の規律が解釈する）を含むパスは、引用しても守れないので何も打たない。
		if p.Path != nil && hasControlChar(*p.Path) {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "path contains control characters"), true
		}
		// ツリーの「ここへ移動」「親のフォルダへ」。シェルでないプログラム（vim・REPL・確認待ちなど）が
		// 前面にいるときは、打った文字がそのプログラムへの入力になってしまうので送らず、busy で断る。
		if t.busy() {
			e := rpc.Errorf(rpc.CodeBusy, "a program is running in the terminal: %s", t.id)
			e.Data, _ = json.Marshal(map[string]any{"reason": "running"})
			return nil, e, true
		}
		ptmx, _ := t.proc()
		if _, err := ptmx.Write(cdInput(p.Path)); err != nil {
			return nil, rpc.Errorf(rpc.CodeNotFound, "terminal has exited: %s", t.id), true
		}
		return struct{}{}, nil, true
	default: // term.input
		b, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "data is not base64: %v", err), true
		}
		ptmx, _ := t.proc()
		if _, err := ptmx.Write(b); err != nil {
			return nil, rpc.Errorf(rpc.CodeNotFound, "terminal has exited: %s", t.id), true
		}
		return struct{}{}, nil, true
	}
}

// termNotify は term.ack を受ける。
func (ss *session) termNotify(req *rpc.Message) {
	if req.Method != "term.ack" || ss.isSuperseded() || ss.needHello() != nil {
		return
	}
	var p struct {
		TermID string `json:"termId"`
		Seq    int64  `json:"seq"`
	}
	if json.Unmarshal(req.Params, &p) != nil {
		return
	}
	if t, err := ss.srv.terms.get(p.TermID); err == nil {
		t.ack(p.Seq)
	}
}

func sortTerms(l []map[string]any) {
	for i := 1; i < len(l); i++ {
		for j := i; j > 0 && termNum(l[j]) < termNum(l[j-1]); j-- {
			l[j], l[j-1] = l[j-1], l[j]
		}
	}
}

func termNum(m map[string]any) int { return termIDNum(m["termId"].(string)) }

func termIDNum(id string) int {
	var n int
	fmt.Sscanf(id, "t%d", &n)
	return n
}

// oscScan は出力の流れから OSC 0 / 2（タイトル）だけを拾う。画面は作らない。
type oscScan struct {
	state int // 0 通常, 1 ESC の次, 2 OSC の中, 3 OSC の中で ESC
	buf   []byte
}

// feed は b を読み、タイトルが決まったら (title, true) を返す（1 度の呼びで最後のもの）。
func (o *oscScan) feed(b []byte) (title string, changed bool) {
	for _, c := range b {
		switch o.state {
		case 0:
			if c == 0x1b {
				o.state = 1
			}
		case 1:
			if c == ']' {
				o.state, o.buf = 2, o.buf[:0]
			} else if c != 0x1b {
				o.state = 0
			}
		case 2:
			switch c {
			case 0x07:
				title, changed = o.end(title, changed)
			case 0x1b:
				o.state = 3
			default:
				if len(o.buf) < 4*maxTitle {
					o.buf = append(o.buf, c)
				}
			}
		case 3:
			if c == '\\' {
				title, changed = o.end(title, changed)
			} else {
				o.state = 0
			}
		}
	}
	return
}

func (o *oscScan) end(title string, changed bool) (string, bool) {
	o.state = 0
	s := string(o.buf)
	if rest, ok := strings.CutPrefix(s, "0;"); ok {
		s = rest
	} else if rest, ok := strings.CutPrefix(s, "2;"); ok {
		s = rest
	} else {
		return title, changed
	}
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	for len(s) > maxTitle {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	return s, true
}

// shellQuote は、シェルに渡す 1 語にする（単引用符で囲み、中の ' は '\” にする。bash・zsh・fish で同じ意味）。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// hasControlChar は、s に制御文字（C0・DEL・C1）が入っているか。
func hasControlChar(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return true
		}
	}
	return false
}

// cdInput は term.cd がシェルに打つ文字。入力の途中の行に続けて実行されないよう、行末へ行って
// 行頭まで消してから打つ（Ctrl+E・Ctrl+U）。path が nil なら cd ..。
func cdInput(path *string) []byte {
	cmd := "cd .."
	if path != nil {
		cmd = "cd -- " + shellQuote(*path)
	}
	return []byte("\x05\x15" + cmd + "\r")
}

// closeTerm は分割したターミナルを終わらせて忘れる（term.close と欄を閉じるときで同じ）。呼ぶ側が一覧を作り直す。
func (m *termManager) closeTerm(id string) {
	t, err := m.get(id)
	if err != nil {
		return
	}
	m.mu.Lock()
	delete(m.terms, id)
	m.mu.Unlock()
	t.hangup()
	t.mu.Lock()
	t.alive = false
	t.mu.Unlock()
}
