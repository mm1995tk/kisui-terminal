package server

// ターミナル管理と term.*。設計は docs/design/gui-protocol.md の 3 章「ターミナル」。
//
// PTY の出力は Screen に変換せず、そのまま term.output で流す（ui/tui/vt は使わない）。
// 出力は 1 ターミナルにつき最大 1 MiB のリングバッファに溜め、seq はそのバイト数の累計。
// GUI が term.ack で返した seq から 256 KiB より先は送らない。止まっても PTY は読み続け、
// 溢れた分は捨てる。捨てた分は term.attach で（残っている分だけ）取り直す。
//
// command-end（OSC 133;D）の印はサーバーでは取り出さない。理由は docs/design/gui-protocol.md の「ターミナル」を見る。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
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

	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
	"github.com/mm1995tk/shijimi-editor/ui/internal/term"
)

const (
	ringSize   = 1 << 20   // 1 ターミナルにつき溜めておく出力
	ackWindow  = 256 << 10 // ack 済みの seq から先へ送ってよい量
	chunkSize  = 32 << 10  // term.output 1 通の最大
	maxTermDim = 1 << 12
	maxTitle   = 256
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
	cmd  *exec.Cmd

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
func (t *terminal) oldest() int64 { return max(0, t.total-ringSize) }

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
func (t *terminal) proc() (*os.File, *exec.Cmd) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ptmx, t.cmd
}

func (t *terminal) hangup() {
	ptmx, cmd := t.proc()
	// SIGHUP を無視するシェルで shutdown が止まらないように、少し待って SIGKILL。
	if cmd.Process != nil {
		p := cmd.Process
		time.AfterFunc(3*time.Second, func() { _ = p.Kill() })
	}
	if cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGHUP)
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
	sess, err := term.Start(term.Options{Shell: sh, Dir: a.dir, Env: env, Cols: a.cols, Rows: a.rows})
	if err != nil {
		m.mu.Unlock()
		return nil, rpc.Errorf(rpc.CodeInternalError, "start shell: %v", err)
	}
	ptmx, cmd := sess.File(), sess.Cmd()
	m.next++
	t := &terminal{
		mgr: m, id: fmt.Sprintf("t%d", m.next), pid: sess.Pid(),
		ptmx: ptmx, cmd: cmd, cols: a.cols, rows: a.rows, alive: true,
		ring: make([]byte, ringSize), wsID: a.wsID, primary: a.primary,
	}
	t.cwd = normalizePath(a.dir) // 以後 cwd の変化を見るので、読み取った値（実パス）に合わせる
	m.terms[t.id] = t
	m.wg.Go(func() { t.pump(ptmx, cmd) })
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
	if m.countSplit(p.WorkspaceID) >= maxSplitTerms {
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
	sess, err := term.Start(term.Options{Shell: term.DefaultShell(), Dir: dir, Env: []string{ctl.EnvGUIPrimary + "=" + t.id, ctl.EnvGUIWorkspace + "=" + wsID}, Cols: cols, Rows: rows})
	if err != nil {
		m.mu.Unlock()
		return nil, rpc.Errorf(rpc.CodeInternalError, "start shell: %v", err)
	}
	ptmx, cmd := sess.File(), sess.Cmd()
	t.mu.Lock()
	t.ptmx, t.cmd, t.pid, t.alive = ptmx, cmd, sess.Pid(), true
	t.cwd = normalizePath(dir)
	t.osc = oscScan{}
	cwd, pid := t.cwd, t.pid
	t.mu.Unlock()
	m.wg.Go(func() { t.pump(ptmx, cmd) })
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

// pump は PTY を読み続けてリングバッファに溜め、送れるなら送る。止まった GUI には送らないが読むのはやめない。
func (t *terminal) pump(ptmx *os.File, cmd *exec.Cmd) {
	buf := make([]byte, chunkSize)
	for {
		n, err := ptmx.Read(buf)
		if n > 0 {
			t.mu.Lock()
			t.ringAppend(buf[:n])
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
			break
		}
	}
	_ = cmd.Wait()
	ptmx.Close()
	exit := map[string]any{"termId": t.id}
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		exit["code"] = 128 + int(ws.Signal())
		exit["signal"] = ws.Signal().String()
	} else {
		exit["code"] = cmd.ProcessState.ExitCode()
	}
	t.mu.Lock()
	t.alive = false
	t.mu.Unlock()
	t.flush() // 最後の出力が先に届くように
	t.mgr.srv.notifyOwner("term.exit", exit)
	t.mgr.srv.ws.recompute()
	t.mgr.srv.log.Info("term exited", "termId", t.id, "code", exit["code"])
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

func (t *terminal) attach(from *int64) (any, error) {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.mu.Lock()
	defer t.mu.Unlock()
	f := int64(0)
	if from != nil {
		f = max(0, *from)
	}
	_, data := t.ringBytes(f, t.total)
	// 取り直した分は GUI が受け取ったことになる。ここから先を流す。
	t.sent, t.acked = t.total, t.total
	return map[string]any{
		"seq": t.total, "replay": base64.StdEncoding.EncodeToString(data), "cols": t.cols, "rows": t.rows,
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
		TermID  string  `json:"termId"`
		FromSeq *int64  `json:"fromSeq"`
		Cols    int     `json:"cols"`
		Rows    int     `json:"rows"`
		Data    string  `json:"data"`
		Path    *string `json:"path"`
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
		res, err = t.attach(p.FromSeq)
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
		if err := pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(p.Rows), Cols: uint16(p.Cols)}); err != nil {
			return nil, rpc.Errorf(rpc.CodeNotFound, "terminal has exited: %s", t.id), true
		}
		t.mu.Lock()
		t.cols, t.rows = p.Cols, p.Rows
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
