package server

// プライマリターミナルの中で動く TUI の shj を知る。設計は docs/design/gui-protocol.md の「プライマリの shj」。
//
// shj serve は、プライマリターミナルのシェルにだけ環境変数 SHIJIMI_GUI_PRIMARY（値はそのターミナルの id）を渡す。
// TUI の shj はそれを見つけたら、serve-primary.rpc（serve.rpc と同じ場所・同じ権限）に 1 行の JSON
// （ctl.PrimaryHello）を送って名乗り、つなぎっぱなしにする。つながっている間がその shj の生きている間で、
// 切れたら（shj が終わったら）ワークスペースの primaryShj が消える。1 つのプライマリで名乗れるのは最初の 1 つだけ。

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// primaryShj はプライマリターミナルで動いている shj。GUI へは workspace の primaryShj で届く。
type primaryShj struct {
	// Socket はその shj の制御用ソケット（core/ctl）の場所。
	Socket string `json:"socket"`
	PID    int    `json:"pid"`
	// File はその shj が今出しているファイル（絶対パス）。テキストか画像を出していなければ空。
	File string `json:"file,omitempty"`
	wsID string // 名乗ったときのワークスペース（リンクを消すため。ワークスペースが先に消えても分かる）
}

type primaryServer struct {
	ln net.Listener

	mu    sync.Mutex
	conns map[net.Conn]struct{}
	wg    sync.WaitGroup
}

// startPrimary は serve-primary.rpc を開く。開けなくても serve は動く（プライマリの shj を知れないだけ）。
func (s *Server) startPrimary() {
	path := filepath.Join(filepath.Dir(s.opts.SocketPath), ctl.ServePrimaryName)
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err == nil {
		err = os.Chmod(path, 0o600)
		if err != nil {
			ln.Close()
		}
	}
	if err != nil {
		s.log.Warn("primary socket", "err", err)
		return
	}
	p := &primaryServer{ln: ln, conns: map[net.Conn]struct{}{}}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		ln.Close()
		return
	}
	s.primary = p
	s.mu.Unlock()
	p.wg.Go(func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			p.conns[c] = struct{}{}
			p.mu.Unlock()
			p.wg.Go(func() {
				s.primaryConn(c)
				p.mu.Lock()
				delete(p.conns, c)
				p.mu.Unlock()
				c.Close()
			})
		}
	})
}

func (s *Server) stopPrimary() {
	s.mu.Lock()
	p := s.primary
	s.primary = nil
	s.mu.Unlock()
	if p == nil {
		return
	}
	p.ln.Close()
	p.mu.Lock()
	for c := range p.conns {
		c.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
}

// primaryConn は 1 本の接続。名乗りを受けて、切れるまで読む。名乗りのあとに来る 1 行ずつの
// ctl.PrimaryFile は、その shj が出しているファイル。読めない行は捨てる。
func (s *Server) primaryConn(c net.Conn) {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 0, 4<<10), 64<<10)
	if !sc.Scan() {
		reply(c, errors.New("no hello"))
		return
	}
	var h ctl.PrimaryHello
	if err := json.Unmarshal(sc.Bytes(), &h); err != nil {
		reply(c, err)
		return
	}
	claim, err := s.ws.claimShj(h)
	if err != nil {
		reply(c, err)
		return
	}
	reply(c, nil)
	_ = c.SetReadDeadline(time.Time{})
	for sc.Scan() { // 切れたら終わる
		var f ctl.PrimaryFile
		if json.Unmarshal(sc.Bytes(), &f) == nil && (f.File == "" || filepath.IsAbs(f.File)) {
			s.ws.setShjFile(claim, f.File)
		}
	}
	s.ws.releaseShj(claim)
}

func reply(c net.Conn, err error) {
	r := ctl.PrimaryReply{OK: err == nil}
	if err != nil {
		r.Error = err.Error()
	}
	b, _ := json.Marshal(r)
	_, _ = c.Write(append(b, '\n'))
}

// claimShj は termID のプライマリターミナルのワークスペースの primaryShj を h にする。
// すでに別の shj がいれば断る。
func (w *wsManager) claimShj(h ctl.PrimaryHello) (*primaryShj, error) {
	if h.Socket == "" || h.PID <= 0 {
		return nil, errors.New("socket and pid are required")
	}
	t, err := w.srv.terms.get(h.TermID)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	primary, wsID := t.primary, t.wsID
	t.mu.Unlock()
	if !primary {
		return nil, errors.New("not a primary terminal")
	}
	claim := &primaryShj{Socket: h.Socket, PID: h.PID, wsID: wsID}
	w.mu.Lock()
	st := w.reg[wsID]
	if st == nil {
		w.mu.Unlock()
		return nil, errors.New("no such workspace")
	}
	if st.shj != nil {
		w.mu.Unlock()
		return nil, errors.New("the primary already has a shj")
	}
	st.shj = claim
	w.mu.Unlock()
	w.linkShj(wsID, claim)
	w.recompute()
	return claim, nil
}

// releaseShj は claim の shj が終わったことを覚える。別の shj に替わっていれば何もしない。
// ワークスペースが先に消えていても、リンクは claim の wsID から消す。
func (w *wsManager) releaseShj(claim *primaryShj) {
	w.mu.Lock()
	for _, st := range w.reg {
		if st.shj == claim {
			st.shj = nil
		}
	}
	w.mu.Unlock()
	w.unlinkShj(claim)
	w.recompute()
}

// setShjFile は claim の shj が出しているファイルを覚え、変わっていれば GUI に知らせる。
// 別の shj に替わっていれば何もしない。
func (w *wsManager) setShjFile(claim *primaryShj, file string) {
	w.mu.Lock()
	changed := false
	for _, st := range w.reg {
		if st.shj == claim && claim.File != file {
			claim.File = file
			changed = true
		}
	}
	w.mu.Unlock()
	if changed {
		w.recompute()
	}
}

// shjOpenTimeout は shj の制御用ソケットに頼むときの待ち時間。
const shjOpenTimeout = 5 * time.Second

// primaryRequest は shj.open。ツリーで押したファイルを、ワークスペースのプライマリの shj で開かせる。
// path はワークスペースのルートからの相対パス（file.open と同じ検査）。プライマリに shj がいなければ not_found。
func (ss *session) primaryRequest(req *rpc.Message) (res any, err error, handled bool) {
	if req.Method != "shj.open" {
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	var p struct {
		WorkspaceID string `json:"workspaceId"`
		Path        string `json:"path"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err), true
	}
	rel, err := cleanRel(p.Path)
	if err != nil {
		return nil, err, true
	}
	if rel == "" {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "the workspace root is not a file"), true
	}
	w := ss.srv.ws
	root, ok := w.rootOf(p.WorkspaceID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.WorkspaceID), true
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := checkFile(root, full, rel); err != nil {
		return nil, err, true
	}
	w.mu.Lock()
	var sock string
	if st := w.reg[p.WorkspaceID]; st != nil && st.shj != nil {
		sock = st.shj.Socket
	}
	w.mu.Unlock()
	if sock == "" {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no shj in the primary terminal of %s", p.WorkspaceID), true
	}
	if err := askShjToOpen(sock, full); err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "%v", err), true
	}
	return struct{}{}, nil, true
}

// askShjToOpen は shj の制御用ソケット（core/ctl）に open を頼む。
func askShjToOpen(sock, full string) error {
	c, err := net.DialTimeout("unix", sock, shjOpenTimeout)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(shjOpenTimeout))
	if err := json.NewEncoder(c).Encode(ctl.Request{Cmd: "open", Path: full}); err != nil {
		return err
	}
	var r ctl.Response
	if err := json.NewDecoder(c).Decode(&r); err != nil {
		return err
	}
	if !r.OK {
		return errors.New(r.Error)
	}
	return nil
}

// linkShj は同じワークスペースのほかのターミナルが引く先（ctl.GUILinkPath）に、claim の shj のソケットへのリンクを置く。
// リンクの先は、ソケット自身が ctl.SocketPath の規則どおり shj serve と同じディレクトリにあるものだけ。
// 置く場所も同じ 0700 のディレクトリの中で、同じユーザーだけ。置けなくても名乗りは通す（届かないだけ）。
func (w *wsManager) linkShj(wsID string, claim *primaryShj) {
	dir := filepath.Dir(w.srv.opts.SocketPath)
	if !filepath.IsAbs(claim.Socket) || filepath.Dir(claim.Socket) != dir {
		w.srv.log.Warn("primary link: socket outside the socket directory", "socket", claim.Socket)
		return
	}
	link := ctl.GUILinkPath(dir, wsID)
	w.linkMu.Lock()
	defer w.linkMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		w.srv.log.Warn("primary link", "err", err)
		return
	}
	tmp := link + ".tmp"
	_ = os.Remove(tmp)
	if err := os.Symlink(claim.Socket, tmp); err != nil {
		w.srv.log.Warn("primary link", "err", err)
		return
	}
	if err := os.Rename(tmp, link); err != nil { // 前のリンク（落ちた shj の残り）は置き換える
		_ = os.Remove(tmp)
		w.srv.log.Warn("primary link", "err", err)
	}
}

// unlinkShj は linkShj のリンクを消す。別の shj に替わったあとのリンクは消さない。
func (w *wsManager) unlinkShj(claim *primaryShj) {
	link := ctl.GUILinkPath(filepath.Dir(w.srv.opts.SocketPath), claim.wsID)
	w.linkMu.Lock()
	defer w.linkMu.Unlock()
	if to, err := os.Readlink(link); err == nil && to == claim.Socket {
		_ = os.Remove(link)
		_ = os.Remove(filepath.Dir(link)) // 空になったときだけ消える
	}
}
