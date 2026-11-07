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
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
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
	Token     string `json:"token,omitempty"` // 欄の中のコマンドの秘密（panecmd）。無ければその欄から kisui open は使えない
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Title     string `json:"title"`
	Name      string `json:"name,omitempty"` // 欄の名前（kisui pane title）
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
	Extras  []extraPane  `json:"extras,omitempty"` // 欄の中から開いた、ターミナルでない欄（wsState.extras）
	// Layout は欄の配置（分割の木）。古い serve は送らない（recompute が欄から作る）
	Layout *layoutNode `json:"layout,omitempty"`
}

type handoverShj struct {
	Socket string           `json:"socket"`
	PID    int              `json:"pid"`
	File   string           `json:"file,omitempty"`
	Diff   *ctl.PrimaryDiff `json:"diff,omitempty"`
	Panes  []string         `json:"panes"`
	Extras []extraPane      `json:"extras"`
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

// handoverParams は server.handover のパラメータ。
type handoverParams struct {
	Executable string `json:"executable"`
	// Env は新しい serve に渡す環境変数。古い serve の環境変数に上書きする（KISUI_SHJ_DIR は、ここに無ければ外す）。
	Env map[string]string `json:"env"`
}

// handoverReq は server.handover。
func (s *Server) handoverReq(req *rpc.Message) (any, error) {
	var p handoverParams
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
	for k, v := range p.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid env: %q", k)
		}
	}
	pid, err := s.handover(p.Executable, successorEnv(os.Environ(), p.Env))
	if err != nil {
		return nil, err
	}
	return map[string]any{"pid": pid}, nil
}

// successorEnv は新しい serve の環境変数。古い serve のもの（古い GUI が kisui attach に渡したもの）から、
// 古い版を指す KISUI_SHJ_DIR を外し、頼んだ側が渡した env を上書きする。KISUI_SHJ_DIR が無ければ、新しい serve は
// 自分の実行ファイルの隣の shj を使う。
func successorEnv(base []string, env map[string]string) []string {
	out := slices.DeleteFunc(slices.Clone(base), func(e string) bool {
		k, _, _ := strings.Cut(e, "=")
		_, override := env[k]
		return k == EnvShjDir || override
	})
	for _, k := range slices.Sorted(maps.Keys(env)) {
		out = append(out, k+"="+env[k])
	}
	return out
}

// handover は exe の kisui serve に引き継ぐ。引き継いだら新しい serve の pid を返す。
// 失敗したら、新しい serve を止めてから元に戻し、動き続ける。
func (s *Server) handover(exe string, env []string) (int, error) {
	ho, err := s.beginHandover()
	if err != nil {
		return 0, err
	}
	committed := false
	defer func() {
		if !committed {
			s.endHandover(ho)
		}
	}()
	s.log.Info("handover: starting", "executable", exe)
	succ, err := startSuccessor(exe, env)
	if err != nil {
		return 0, handoverError(s, "start the new kisui serve", err)
	}
	ver, err := succ.negotiate()
	if err != nil {
		succ.abort()
		return 0, handoverError(s, "negotiate", err)
	}
	pid, err := s.transfer(succ, ver)
	if err != nil {
		return 0, err
	}
	committed = true
	s.commit(ho, succ)
	s.log.Info("handover: done", "pid", pid)
	return pid, nil
}

// beginHandover は引き継ぎを始めたことを覚える。止まる途中・別の引き継ぎの途中なら busy。
func (s *Server) beginHandover() (*handoverRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ho != nil || s.handedOver || s.closed || s.stopping {
		return nil, rpc.Errorf(rpc.CodeBusy, "kisui serve is stopping or handing over")
	}
	s.ho = &handoverRun{done: make(chan struct{})}
	return s.ho, nil
}

// endHandover は、引き継げずに終わったことを、待っている accept の goroutine に知らせる。
func (s *Server) endHandover(ho *handoverRun) {
	s.mu.Lock()
	s.ho = nil
	s.mu.Unlock()
	close(ho.done)
}

// transfer は仕事を止めて、状態と fd を送り、ready を待つ。返るとき opMu の書きロックを持ったまま
// （commit が離す）。失敗したら、新しい serve を止めてから元に戻し、ロックを離す。
func (s *Server) transfer(succ *successor, ver int) (int, error) {
	s.opMu.Lock()
	unfreeze, err := s.freeze()
	if err != nil {
		succ.abort()
		s.opMu.Unlock()
		return 0, handoverError(s, "pause", err)
	}
	pid, err := s.sendState(succ, ver)
	if err != nil {
		succ.abort() // 新しい serve が受け取った fd で読み始めないうちに止めてから、戻す
		unfreeze()
		s.opMu.Unlock()
		return 0, err
	}
	return pid, nil
}

// sendState は止めた状態と fd を送り、新しい serve の ready を待って、その pid を返す。
func (s *Server) sendState(succ *successor, ver int) (int, error) {
	st, fds, err := s.collect(ver)
	if err != nil {
		return 0, handoverError(s, "collect the state", err)
	}
	_ = succ.conn.SetDeadline(time.Now().Add(handoverReadyTimeout))
	if err := writeFrame(succ.conn, handoverMsg{Type: "state", State: st}); err != nil {
		return 0, handoverError(s, "send the state", err)
	}
	if err := sendFDs(succ.conn, fds); err != nil {
		return 0, handoverError(s, "send the file descriptors", err)
	}
	var ready handoverMsg
	if err := readFrame(succ.conn, &ready); err != nil {
		return 0, handoverError(s, "the new kisui serve did not take over", err)
	}
	if ready.Type != "ready" {
		return 0, handoverError(s, "the new kisui serve did not take over", errors.New(ready.Error))
	}
	return ready.PID, nil
}

// commit は引き継いだことにする。以後、古い serve は PTY も shj の接続も読まない。opMu の書きロックを離す。
func (s *Server) commit(ho *handoverRun, succ *successor) {
	s.mu.Lock()
	s.handedOver = true
	ho.committed = true
	s.mu.Unlock()
	_ = writeFrame(succ.conn, handoverMsg{Type: "go"})
	succ.conn.Close()
	go func() { _ = succ.cmd.Wait() }() // 新しい serve は setsid してある。終わったら刈り取るだけ
	s.reapShells()
	close(ho.done)
	s.opMu.Unlock()
}

// reapShells は、渡した自分の子のシェルが終わったら刈り取る（このプロセスが残っている間、ゾンビにしないため）。
func (s *Server) reapShells() {
	for _, t := range s.terms.all() {
		t.mu.Lock()
		c, alive := t.cmd, t.alive
		t.mu.Unlock()
		if c != nil && alive {
			go func() { _ = c.Wait() }()
		}
	}
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

// successor は起動した新しい serve と、その socketpair。
type successor struct {
	cmd  *exec.Cmd
	conn *net.UnixConn
}

// startSuccessor は exe を `serve --handover` で起動し、socketpair の片方を fd 3 で渡す。
// 新しい serve は GUI から切り離す（setsid。標準入出力は /dev/null。ログは自分のファイルへ）。
// 標準エラー出力をパイプにしないのは、古い serve が終わったあとに書かれて新しい serve が死なないように。
func startSuccessor(exe string, env []string) (*successor, error) {
	syscall.ForkLock.RLock()
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err == nil {
		syscall.CloseOnExec(pair[0])
		syscall.CloseOnExec(pair[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, err
	}
	mine, theirs := os.NewFile(uintptr(pair[0]), "handover"), os.NewFile(uintptr(pair[1]), "handover")
	defer theirs.Close()
	c, err := net.FileConn(mine)
	mine.Close()
	if err != nil {
		return nil, err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		c.Close()
		return nil, err
	}
	defer null.Close()
	cmd := exec.Command(exe, "serve", "--handover")
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	cmd.ExtraFiles = []*os.File{theirs} // fd 3
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		c.Close()
		return nil, err
	}
	return &successor{cmd: cmd, conn: c.(*net.UnixConn)}, nil
}

// negotiate は新しい serve の hello を待ち、使う版を決める。
func (succ *successor) negotiate() (int, error) {
	_ = succ.conn.SetDeadline(time.Now().Add(handoverHelloTimeout))
	var hello handoverMsg
	if err := readFrame(succ.conn, &hello); err != nil {
		return 0, fmt.Errorf("the new kisui serve did not answer: %w", err)
	}
	if hello.Type == "error" {
		return 0, fmt.Errorf("the new kisui serve refused: %s", hello.Error)
	}
	ver := pickVersion(hello.Versions)
	if hello.Type != "hello" || ver == 0 {
		err := fmt.Errorf("no common handover version (old %v, new %v)", handoverVersions, hello.Versions)
		_ = writeFrame(succ.conn, handoverMsg{Type: "error", Error: err.Error()})
		return 0, err
	}
	return ver, nil
}

// abort は新しい serve を止める（受け取った fd で読み始めないうちに）。
func (succ *successor) abort() {
	_ = succ.cmd.Process.Kill()
	_ = succ.cmd.Wait()
	succ.conn.Close()
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
