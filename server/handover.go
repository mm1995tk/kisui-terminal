package server

// 引き継ぎ（server.handover）。動いている kisui serve が、欄のシェルと画面を消さずに、別の実行ファイルの
// kisui serve（新しい版）に入れ替わる。設計は docs/design/gui-protocol.md の「kisui serve の引き継ぎ」。
//
// 古い serve（このファイル）は、頼まれた実行ファイルを `kisui serve --handover` で起動し、socketpair の片方を
// fd 3 で渡す。その上で次の順に話す（1 通は 4 バイトの長さ + JSON。fd は SCM_RIGHTS）。
//
//  1. 新 → 古：hello（話せる手順の版の一覧）。起動できなければ error
//  2. 古：仕事を止めて状態を固める（freeze）。GUI の要求・shj の名乗りと欄の頼み・見回りを止め、
//     待ち受けと shj の接続と PTY の読みを、読みの期限で止める
//  3. 古 → 新：state（ワークスペース・欄・画面の書き出し・リング・shj の接続の読みかけ）と fd
//  4. 新 → 古：ready（自分の pid）。作れなければ error
//  5. 古 → 新：go。古い serve はここで引き継いだことにして、以後は何もしない（GUI の接続を閉じて終わる）
//
// 4 の前に失敗したら（新が error を返した・終わった・時間切れ）、古い serve は新を SIGKILL で止めてから
// 止めていたものを戻して動き続ける。新は go を受けるか、古い serve との接続が閉じるまで何も読まない
// （古い serve が先に死んだときも、受け取った状態で動き始める）。

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"time"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapHandover は session.hello の capabilities に入れる、server.handover を受けられる印。
const CapHandover = "server.handover"

// handoverVersions は、この serve が話せる引き継ぎの手順とデータの形の版（古い側でも新しい側でも）。
// 形を変えるときは版を足し、古い版もしばらく話せるようにしておく（前後の版どうしで引き継げるように）。
var handoverVersions = []int{1}

const (
	// handoverHelloTimeout は、新しい serve が起動して hello を返すまで待つ時間。
	handoverHelloTimeout = 30 * time.Second
	// handoverReadyTimeout は、状態を送ってから ready を待つ時間（この間 GUI の要求は待たされる）。
	handoverReadyTimeout = 60 * time.Second
	// handoverPauseTimeout は、PTY と shj の接続の読みが止まるのを待つ時間。
	handoverPauseTimeout = 5 * time.Second
	// maxHandoverFrame は 1 通の上限。
	maxHandoverFrame = 1 << 30
	// fdBatch は SCM_RIGHTS 1 回で送る fd の数。
	fdBatch = 64
)

var errHandedOver = errors.New("kisui serve has handed over to another kisui serve; send it again")

// errHandedOverRPC は、引き継ぎの間に届いて、何もしないまま引き継いだ要求への返事。
func errHandedOverRPC() *rpc.Error {
	e := rpc.Errorf(rpc.CodeBusy, "%v", errHandedOver)
	e.Data, _ = json.Marshal(map[string]any{"reason": "handover"})
	return e
}

// handoverRun は進んでいる引き継ぎ。done が閉じたら committed が決まっている。
type handoverRun struct {
	done      chan struct{}
	committed bool
}

// handoverMsg は socketpair の上の 1 通。
type handoverMsg struct {
	Type     string         `json:"type"` // hello | state | ready | go | error
	Versions []int          `json:"versions,omitempty"`
	PID      int            `json:"pid,omitempty"`
	Error    string         `json:"error,omitempty"`
	State    *handoverState `json:"state,omitempty"`
}

// handoverState は古い serve から新しい serve へ渡す状態（版 1）。fd は、state の後に送る fd の並びの位置。
type handoverState struct {
	Version       int                          `json:"version"`
	SocketPath    string                       `json:"socketPath"`
	FDs           int                          `json:"fds"`      // state のあとに送る fd の数
	Listener      int                          `json:"listener"` // serve.rpc の待ち受け
	PrimaryPath   string                       `json:"primaryPath,omitempty"`
	PrimaryLn     int                          `json:"primaryListener"` // serve-primary.rpc の待ち受け。無ければ -1
	ServerID      string                       `json:"serverId"`
	StartedAt     time.Time                    `json:"startedAt"`
	LastClient    time.Time                    `json:"lastClient"`
	Rev           int64                        `json:"rev"`
	NextTerm      int                          `json:"nextTerm"`
	NextWorkspace int                          `json:"nextWorkspace"`
	NextExtra     int                          `json:"nextExtra"`
	Focus         string                       `json:"focus,omitempty"`
	Terms         []handoverTerm               `json:"terms"`
	Workspaces    []handoverWS                 `json:"workspaces"`
	Links         []handoverLink               `json:"links"`
	Tree          map[string]map[string]string `json:"tree,omitempty"`
	TreeRev       int64                        `json:"treeRev"`
	GitRev        int64                        `json:"gitRev"`
}

type handoverTerm struct {
	ID        string `json:"id"`
	PID       int    `json:"pid"`
	FD        int    `json:"fd"` // PTY の master。シェルが終わっていれば -1
	Cwd       string `json:"cwd"`
	Workspace string `json:"workspace"`
	Primary   bool   `json:"primary"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Title     string `json:"title"`
	Alive     bool   `json:"alive"`
	RingStart int64  `json:"ringStart"` // Ring の先頭の seq
	Ring      []byte `json:"ring"`      // リングに残っている出力（seq は RingStart から）
	Sent      int64  `json:"sent"`
	Acked     int64  `json:"acked"`
	Screen    []byte `json:"screen"` // 画面の状態の書き出し（seq は RingStart+len(Ring) まで）
}

type handoverWS struct {
	ID      string       `json:"id"`
	Seq     int          `json:"seq"`
	Root    string       `json:"root,omitempty"`
	Kind    string       `json:"kind,omitempty"`
	Primary string       `json:"primary"`
	Shj     *handoverShj `json:"shj,omitempty"`
}

type handoverShj struct {
	Socket string      `json:"socket"`
	PID    int         `json:"pid"`
	File   string      `json:"file,omitempty"`
	Panes  []string    `json:"panes"`
	Extras []extraPane `json:"extras"`
}

// handoverLink は名乗った shj の接続。Pending は古い serve が読んだが、まだ行として扱っていない分。
type handoverLink struct {
	Workspace string `json:"workspace"`
	FD        int    `json:"fd"`
	Pending   []byte `json:"pending,omitempty"`
}

func (s *Server) isHandedOver() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.handedOver
}

// whileServing は、引き継いでいなければ f を読みロックの中で呼ぶ（定期の見回り用）。
func (s *Server) whileServing(f func()) {
	s.opMu.RLock()
	defer s.opMu.RUnlock()
	if !s.isHandedOver() {
		f()
	}
}

// waitHandover は、進んでいる引き継ぎがあれば終わるまで待ち、引き継いだかを返す。
func (s *Server) waitHandover() bool {
	s.mu.Lock()
	ho, done := s.ho, s.handedOver
	s.mu.Unlock()
	if ho != nil {
		<-ho.done
		return ho.committed
	}
	return done
}

// leave は引き継いだあとの古い serve の後片付け。シェルに合図は送らず、ソケットも消さない。
// 引き継ぎの返事が GUI に届くよう少し待ってから、GUI の接続と、自分の持つ fd を閉じる。
func (s *Server) leave() {
	s.leaveOnce.Do(func() {
		time.Sleep(shutdownGrace)
		s.mu.Lock()
		s.closed = true
		var open []*session
		for ss := range s.sessions {
			open = append(open, ss)
		}
		p := s.primary
		s.mu.Unlock()
		for _, ss := range open {
			ss.conn.Close()
		}
		s.ln.Close() // SetUnlinkOnClose(false) にしてある
		if p != nil {
			p.ln.Close()
			p.mu.Lock()
			for c := range p.links {
				c.Close()
			}
			p.mu.Unlock()
		}
		for _, t := range s.terms.all() {
			if ptmx, _ := t.proc(); ptmx != nil {
				ptmx.Close()
			}
		}
		s.wg.Wait()
		s.log.Info("handed over")
	})
}

// handoverReq は server.handover。
func (s *Server) handoverReq(req *rpc.Message) (any, error) {
	var p struct {
		Executable string `json:"executable"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	if !filepath.IsAbs(p.Executable) {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "executable must be an absolute path: %q", p.Executable)
	}
	fi, err := os.Stat(p.Executable)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode()&0o111 == 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "not an executable file: %s", p.Executable)
	}
	pid, err := s.handover(p.Executable)
	if err != nil {
		return nil, err
	}
	return map[string]any{"pid": pid}, nil
}

// handover は exe の kisui serve に引き継ぐ。引き継いだら新しい serve の pid を返す。
// 失敗したら、新しい serve を止めてから元に戻し、動き続ける。
func (s *Server) handover(exe string) (int, error) {
	s.mu.Lock()
	if s.ho != nil || s.handedOver || s.closed || s.stopping {
		s.mu.Unlock()
		return 0, rpc.Errorf(rpc.CodeBusy, "kisui serve is stopping or handing over")
	}
	ho := &handoverRun{done: make(chan struct{})}
	s.ho = ho
	s.mu.Unlock()
	committed := false
	defer func() {
		if !committed {
			s.mu.Lock()
			s.ho = nil
			s.mu.Unlock()
			close(ho.done)
		}
	}()
	s.log.Info("handover: starting", "executable", exe)
	cmd, conn, err := startSuccessor(exe)
	if err != nil {
		return 0, handoverError(s, "start the new kisui serve", err)
	}
	// abort は新しい serve を止める（受け取った fd で読み始めないうちに）。止めてから元に戻す。
	abort := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		conn.Close()
	}

	_ = conn.SetDeadline(time.Now().Add(handoverHelloTimeout))
	var hello handoverMsg
	if err := readFrame(conn, &hello); err != nil {
		abort()
		return 0, handoverError(s, "the new kisui serve did not answer", err)
	}
	if hello.Type == "error" {
		abort()
		return 0, handoverError(s, "the new kisui serve refused", errors.New(hello.Error))
	}
	ver := pickVersion(hello.Versions)
	if hello.Type != "hello" || ver == 0 {
		_ = writeFrame(conn, handoverMsg{Type: "error", Error: fmt.Sprintf("no common handover version (old %v, new %v)", handoverVersions, hello.Versions)})
		abort()
		return 0, handoverError(s, "no common handover version", fmt.Errorf("old %v, new %v", handoverVersions, hello.Versions))
	}

	s.opMu.Lock()
	unfreeze, err := s.freeze()
	if err != nil {
		abort()
		s.opMu.Unlock()
		return 0, handoverError(s, "pause", err)
	}
	rollback := func(what string, err error) (int, error) {
		abort()
		unfreeze()
		s.opMu.Unlock()
		return 0, handoverError(s, what, err)
	}
	st, fds, err := s.collect(ver)
	if err != nil {
		return rollback("collect the state", err)
	}
	_ = conn.SetDeadline(time.Now().Add(handoverReadyTimeout))
	if err := writeFrame(conn, handoverMsg{Type: "state", State: st}); err != nil {
		return rollback("send the state", err)
	}
	if err := sendFDs(conn, fds); err != nil {
		return rollback("send the file descriptors", err)
	}
	var ready handoverMsg
	if err := readFrame(conn, &ready); err != nil {
		return rollback("the new kisui serve did not take over", err)
	}
	if ready.Type != "ready" {
		return rollback("the new kisui serve did not take over", errors.New(ready.Error))
	}

	// ここで引き継いだことになる。以後、古い serve は PTY も shj の接続も読まない。
	s.mu.Lock()
	s.handedOver = true
	ho.committed = true
	s.mu.Unlock()
	committed = true
	_ = writeFrame(conn, handoverMsg{Type: "go"})
	conn.Close()
	go func() { _ = cmd.Wait() }() // 新しい serve は setsid してある。終わったら刈り取るだけ
	for _, t := range s.terms.all() {
		// 渡したシェルが終わったら刈り取る（このプロセスが残っている間、ゾンビにしないため）
		t.mu.Lock()
		c, alive := t.cmd, t.alive
		t.mu.Unlock()
		if c != nil && alive {
			go func() { _ = c.Wait() }()
		}
	}
	close(ho.done)
	s.opMu.Unlock()
	s.log.Info("handover: done", "pid", ready.PID)
	return ready.PID, nil
}

func handoverError(s *Server, what string, err error) error {
	s.log.Warn("handover failed; keep serving", "step", what, "err", err)
	return rpc.Errorf(rpc.CodeInternalError, "handover failed: %s: %v", what, err)
}

// pickVersion は、相手の版の一覧と自分の版の一覧の両方にある一番新しい版。無ければ 0。
func pickVersion(theirs []int) int {
	best := 0
	for _, v := range handoverVersions {
		if slices.Contains(theirs, v) && v > best {
			best = v
		}
	}
	return best
}

// startSuccessor は exe を `serve --handover` で起動し、socketpair の片方を fd 3 で渡す。
// 新しい serve は GUI から切り離す（setsid。標準入出力は /dev/null。ログは自分のファイルへ）。
// 標準エラー出力をパイプにしないのは、古い serve が終わったあとに書かれて新しい serve が死なないように。
func startSuccessor(exe string) (*exec.Cmd, *net.UnixConn, error) {
	syscall.ForkLock.RLock()
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err == nil {
		syscall.CloseOnExec(pair[0])
		syscall.CloseOnExec(pair[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, nil, err
	}
	mine, theirs := os.NewFile(uintptr(pair[0]), "handover"), os.NewFile(uintptr(pair[1]), "handover")
	defer theirs.Close()
	c, err := net.FileConn(mine)
	mine.Close()
	if err != nil {
		return nil, nil, err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		c.Close()
		return nil, nil, err
	}
	defer null.Close()
	cmd := exec.Command(exe, "serve", "--handover")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	cmd.ExtraFiles = []*os.File{theirs} // fd 3
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		c.Close()
		return nil, nil, err
	}
	return cmd, c.(*net.UnixConn), nil
}

// RefuseHandover は、`kisui serve --handover` が引き継ぐ前に失敗したとき（設定の間違いなど）、
// その理由を古い serve に伝える。f は fd 3。
func RefuseHandover(f *os.File, err error) {
	defer f.Close()
	c, cerr := net.FileConn(f)
	if cerr != nil {
		return
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_ = writeFrame(c, handoverMsg{Type: "error", Error: err.Error()})
}

// freeze は、状態を変えるものを止める。s.opMu の書きロックを持って呼ぶ（GUI の要求などはもう止まっている）。
// 待ち受け・名乗った shj の接続・PTY の読みを、読みの期限で止める。戻すときは unfreeze を呼ぶ。
func (s *Server) freeze() (unfreeze func(), err error) {
	var undo []func()
	unfreeze = func() {
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i]()
		}
	}
	past := time.Unix(1, 0)
	s.ln.SetUnlinkOnClose(false)
	undo = append(undo, func() { s.ln.SetUnlinkOnClose(true) })
	if err := s.ln.SetDeadline(past); err != nil {
		unfreeze()
		return nil, err
	}
	undo = append(undo, func() { _ = s.ln.SetDeadline(time.Time{}) })
	s.mu.Lock()
	p := s.primary
	s.mu.Unlock()
	if p != nil {
		p.ln.SetUnlinkOnClose(false)
		undo = append(undo, func() { p.ln.SetUnlinkOnClose(true) })
		if err := p.ln.SetDeadline(past); err != nil {
			unfreeze()
			return nil, err
		}
		undo = append(undo, func() { _ = p.ln.SetDeadline(time.Time{}) })
		p.mu.Lock()
		var links []*primaryLink
		for _, l := range p.links {
			links = append(links, l)
		}
		p.mu.Unlock()
		for _, l := range links {
			l.mu.Lock()
			if l.claim == nil || l.ended {
				l.mu.Unlock()
				continue // 名乗る前の接続は渡さない
			}
			l.pausing, l.parked, l.resume = true, make(chan struct{}), make(chan struct{})
			parked, resume := l.parked, l.resume
			l.mu.Unlock()
			undo = append(undo, func() {
				_ = l.conn.SetReadDeadline(time.Time{})
				l.mu.Lock()
				l.pausing = false
				l.mu.Unlock()
				close(resume)
			})
			if err := l.conn.SetReadDeadline(past); err != nil {
				unfreeze()
				return nil, err
			}
			select {
			case <-parked:
			case <-time.After(handoverPauseTimeout):
				unfreeze()
				return nil, errors.New("a shj connection did not pause")
			}
		}
	}
	for _, t := range s.terms.all() {
		t.mu.Lock()
		done := t.pumpDone
		if done == nil {
			t.mu.Unlock()
			continue
		}
		select {
		case <-done:
			t.mu.Unlock()
			continue
		default:
		}
		t.pausing, t.parked, t.resume = true, make(chan struct{}), make(chan struct{})
		ptmx, parked, resume := t.ptmx, t.parked, t.resume
		t.mu.Unlock()
		undo = append(undo, func() {
			_ = ptmx.SetReadDeadline(time.Time{})
			t.mu.Lock()
			t.pausing = false
			t.mu.Unlock()
			close(resume)
		})
		if err := ptmx.SetReadDeadline(past); err != nil {
			unfreeze()
			return nil, fmt.Errorf("terminal %s: %w", t.id, err)
		}
		select {
		case <-parked:
		case <-done:
		case <-time.After(handoverPauseTimeout):
			unfreeze()
			return nil, fmt.Errorf("terminal %s did not pause", t.id)
		}
	}
	return unfreeze, nil
}

// collect は、止めた状態を handoverState と、送る fd の並びにする。fd は持っているものの番号をそのまま使う
// （止めている間は閉じないので、送り終えるまで有効）。
func (s *Server) collect(ver int) (*handoverState, []int, error) {
	var fds []int
	add := func(sc syscall.Conn) (int, error) {
		rc, err := sc.SyscallConn()
		if err != nil {
			return -1, err
		}
		var fd int
		if err := rc.Control(func(f uintptr) { fd = int(f) }); err != nil {
			return -1, err
		}
		fds = append(fds, fd)
		return len(fds) - 1, nil
	}
	st := &handoverState{Version: ver, SocketPath: s.opts.SocketPath, PrimaryLn: -1, ServerID: s.serverID, StartedAt: s.startedAt}
	var err error
	if st.Listener, err = add(s.ln); err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	p := s.primary
	st.Rev = s.rev
	st.LastClient = s.lastClient
	if len(s.sessions) > 0 {
		st.LastClient = s.now() // つながっている GUI は引き継ぎのあとに切れる
	}
	s.mu.Unlock()

	// 名乗った shj の接続（止まっているもの）
	if p != nil {
		st.PrimaryPath = p.path
		if st.PrimaryLn, err = add(p.ln); err != nil {
			return nil, nil, err
		}
		p.mu.Lock()
		var links []*primaryLink
		for _, l := range p.links {
			links = append(links, l)
		}
		p.mu.Unlock()
		for _, l := range links {
			l.mu.Lock()
			claim, ended := l.claim, l.ended
			l.mu.Unlock()
			if claim == nil || ended {
				continue
			}
			uc, ok := l.conn.(*net.UnixConn)
			if !ok {
				continue
			}
			fd, err := add(uc)
			if err != nil {
				return nil, nil, err
			}
			st.Links = append(st.Links, handoverLink{Workspace: claim.wsID, FD: fd, Pending: l.pending()})
		}
	}

	// ワークスペース
	w := s.ws
	w.mu.Lock()
	st.NextWorkspace, st.NextExtra, st.Focus = w.next, w.nextExtra, w.focus
	for _, x := range w.reg {
		hw := handoverWS{ID: x.id, Seq: x.seq, Root: x.root, Kind: x.kind, Primary: x.primary}
		if x.shj != nil {
			hw.Shj = &handoverShj{Socket: x.shj.Socket, PID: x.shj.PID, File: x.shj.File,
				Panes: slices.Clone(x.shj.panes), Extras: slices.Clone(x.shj.extras)}
		}
		st.Workspaces = append(st.Workspaces, hw)
	}
	w.mu.Unlock()
	slices.SortFunc(st.Workspaces, func(a, b handoverWS) int { return a.Seq - b.Seq })

	// ターミナル
	s.terms.mu.Lock()
	st.NextTerm = s.terms.next
	s.terms.mu.Unlock()
	for _, t := range s.terms.all() {
		t.mu.Lock()
		ht := handoverTerm{ID: t.id, PID: t.pid, FD: -1, Cwd: t.cwd, Workspace: t.wsID, Primary: t.primary,
			Cols: t.cols, Rows: t.rows, Title: t.title, Alive: t.alive, Sent: t.sent, Acked: t.acked}
		ht.RingStart, ht.Ring = t.ringBytes(t.oldest(), t.total)
		ptmx := t.ptmx
		res := t.feed.snapshot(snapshotScrollback)
		t.mu.Unlock()
		if ht.Alive {
			if ht.FD, err = add(ptmx); err != nil {
				return nil, nil, fmt.Errorf("terminal %s: %w", t.id, err)
			}
		}
		if r := <-res; r.err == nil {
			ht.Screen = r.data
		} else {
			s.log.Warn("handover: no screen state", "termId", t.id, "err", r.err)
		}
		st.Terms = append(st.Terms, ht)
	}
	slices.SortFunc(st.Terms, func(a, b handoverTerm) int { return termIDNum(a.ID) - termIDNum(b.ID) })

	// ツリーの監視
	tw := s.tree.w
	tw.mu.Lock()
	if len(tw.ws) > 0 {
		st.Tree = map[string]map[string]string{}
		for id, m := range tw.ws {
			cp := map[string]string{}
			for k, v := range m {
				cp[k] = v
			}
			st.Tree[id] = cp
		}
	}
	tw.mu.Unlock()
	st.TreeRev, st.GitRev = s.tree.rev.Load(), s.tree.gitRev.Load()
	st.FDs = len(fds)
	return st, fds, nil
}

func writeFrame(c net.Conn, m handoverMsg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(b)))
	if _, err := c.Write(n[:]); err != nil {
		return err
	}
	_, err = c.Write(b)
	return err
}

func readFrame(c net.Conn, m *handoverMsg) error {
	var n [4]byte
	if _, err := io.ReadFull(c, n[:]); err != nil {
		return err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > maxHandoverFrame {
		return fmt.Errorf("handover message too large: %d", size)
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(c, b); err != nil {
		return err
	}
	return json.Unmarshal(b, m)
}

// sendFDs は fds を fdBatch ずつ送る。1 回は 1 バイト（その回の数）に SCM_RIGHTS を付けたもの。
func sendFDs(c *net.UnixConn, fds []int) error {
	for len(fds) > 0 {
		n := min(len(fds), fdBatch)
		if _, _, err := c.WriteMsgUnix([]byte{byte(n)}, syscall.UnixRights(fds[:n]...), nil); err != nil {
			return err
		}
		fds = fds[n:]
	}
	return nil
}

// recvFDs は sendFDs が送った n 個の fd を受ける。受けた fd は close-on-exec（net が付ける）。
func recvFDs(c *net.UnixConn, n int) ([]int, error) {
	var out []int
	buf := make([]byte, 1)
	oob := make([]byte, syscall.CmsgSpace(fdBatch*4))
	for len(out) < n {
		_, oobn, flags, _, err := c.ReadMsgUnix(buf, oob)
		if err != nil {
			closeFDs(out)
			return nil, err
		}
		msgs, err := syscall.ParseSocketControlMessage(oob[:oobn])
		if err != nil {
			closeFDs(out)
			return nil, err
		}
		var got []int
		for i := range msgs {
			fds, err := syscall.ParseUnixRights(&msgs[i])
			if err == nil {
				got = append(got, fds...)
			}
		}
		out = append(out, got...)
		if flags&syscall.MSG_CTRUNC != 0 || len(got) != int(buf[0]) {
			closeFDs(out)
			return nil, errors.New("file descriptors were cut off")
		}
	}
	return out, nil
}

func closeFDs(fds []int) {
	for _, fd := range fds {
		syscall.Close(fd)
	}
}
