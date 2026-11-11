package server

// プライマリターミナルの中で動く TUI の shj を知る。設計は docs/design/gui-protocol.md の「プライマリの shj」。
//
// kisui serve は、どのターミナルのシェルにも環境変数 SHIJIMI_GUI_PRIMARY（値はそのターミナルの id）を渡す。
// 分割したターミナルがプライマリに昇格したあとでも、中の shj が名乗れるように。名乗りを受けるとき、
// そのターミナルが今プライマリかは claimShj が確かめる（昇格の前の分割したターミナルは断る）。
// TUI の shj はそれを見つけたら、serve-primary.rpc（serve.rpc と同じ場所・同じ権限）に 1 行の JSON
// （ctl.PrimaryHello）を送って名乗り、つなぎっぱなしにする。つながっている間がその shj の生きている間で、
// 切れたら（shj が終わったら）ワークスペースの primaryShj が消える。1 つのプライマリで名乗れるのは最初の 1 つだけ。

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// primaryShj はプライマリターミナルで動いている shj。GUI へは workspace の primaryShj で届く。
type primaryShj struct {
	// Socket はその shj の制御用ソケット（core/ctl）の場所。
	Socket string `json:"socket"`
	PID    int    `json:"pid"`
	// File はその shj が今出しているファイル（絶対パス）。テキストか画像を出していなければ空。
	File string `json:"file,omitempty"`
	// Diff は shj が差分モードのときの変更の一覧（CHANGES）。差分モードでなければ nil。
	// 入れ替えるだけで中身は書き換えない（recompute が写しを渡すため）。
	Diff   *ctl.PrimaryDiff `json:"diff,omitempty"`
	wsID   string           // 名乗ったときのワークスペース（リンクを消すため。ワークスペースが先に消えても分かる）
	panes  []string         // この shj が作った欄（ターミナルの id）。w.mu で守る。shj が終わると閉じる
	extras []extraPane      // この shj が開かせた、ターミナルでない欄（動画）。w.mu で守る。shj が終わると消える
}

type primaryServer struct {
	ln   *net.UnixListener
	path string

	mu    sync.Mutex
	links map[net.Conn]*primaryLink
	wg    sync.WaitGroup
}

// primaryLink は serve-primary.rpc の 1 本の接続。名乗った shj の接続は、引き継ぎ（handover.go）で
// 次の serve に渡すため、行の途中で読みを止められるようにしてある。
type primaryLink struct {
	conn     net.Conn
	r        *bufio.Reader
	partial  []byte // 読みかけの行
	skipping bool   // 上限を超えた行の残りを読み捨てている

	mu    sync.Mutex
	claim *primaryShj // 名乗りが通った shj。名乗る前は nil
	ended bool        // 読みが終わった（shj が切った）。mu の中で pause.end を呼ぶ
	pause pauser      // 引き継ぎで読みを止める
}

// maxPrimaryLine は serve-primary.rpc の 1 行の上限。
const maxPrimaryLine = 4 << 20

// maxDiffFiles は差分モードの一覧で受けるファイルの数の上限。これより先は捨てる。
const maxDiffFiles = 5000

var errPrimaryLineTooLong = errors.New("line too long")

func newPrimaryLink(c net.Conn, pending []byte) *primaryLink {
	var r io.Reader = c
	if len(pending) > 0 {
		r = io.MultiReader(bytes.NewReader(pending), c)
	}
	return &primaryLink{conn: c, r: bufio.NewReaderSize(r, 4<<10)}
}

// readLine は次の 1 行（改行を除く）を返す。読みが止められても、読みかけの分は失わない。
// 上限（maxPrimaryLine）を超える行は、改行まで読み捨てて errPrimaryLineTooLong を返す（接続は読み続けられる）。
func (l *primaryLink) readLine() ([]byte, error) {
	for {
		chunk, err := l.r.ReadSlice('\n')
		if l.skipping {
			switch {
			case err == nil:
				l.skipping = false
				return nil, errPrimaryLineTooLong
			case errors.Is(err, bufio.ErrBufferFull):
				continue
			}
			return nil, err
		}
		l.partial = append(l.partial, chunk...)
		if len(l.partial) > maxPrimaryLine+1 {
			l.partial = nil
			switch {
			case err == nil:
				return nil, errPrimaryLineTooLong
			case errors.Is(err, bufio.ErrBufferFull):
				l.skipping = true
				continue
			}
			l.skipping = true // 読みが止められても、再開したあと残りを新しい行として読まない
			return nil, err
		}
		switch {
		case err == nil:
			line := bytes.TrimRight(l.partial, "\r\n")
			l.partial = nil
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		}
		return nil, err
	}
}

// pending は、読んだがまだ行として扱っていない分（読みかけの行と、bufio に溜まっている分）。止まっているときに呼ぶ。
func (l *primaryLink) pending() []byte {
	b, _ := l.r.Peek(l.r.Buffered())
	return append(slices.Clone(l.partial), b...)
}

// end は読みが終わったことを覚える。止めるよう頼まれていれば、待っている側を起こす。
func (l *primaryLink) end() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ended = true
	l.pause.end()
}

// primarySocketPath は serve-primary.rpc の場所（serve.rpc と同じディレクトリ）。shj の名乗りと欄の中のコマンドが使う。
func (s *Server) primarySocketPath() string {
	return filepath.Join(filepath.Dir(s.opts.SocketPath), ctl.ServePrimaryName)
}

// startPrimary は serve-primary.rpc を開く。開けなくても serve は動く（プライマリの shj を知れないだけ）。
func (s *Server) startPrimary() {
	path := s.primarySocketPath()
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
	s.servePrimary(ln.(*net.UnixListener), path, nil)
}

// servePrimary は ln で名乗りと欄の頼みを受ける。links は引き継いだ、名乗り済みの shj の接続。
func (s *Server) servePrimary(ln *net.UnixListener, path string, links []*primaryLink) {
	p := &primaryServer{ln: ln, path: path, links: map[net.Conn]*primaryLink{}}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		ln.Close()
		for _, l := range links {
			l.conn.Close()
		}
		return
	}
	s.primary = p
	s.mu.Unlock()
	run := func(l *primaryLink, f func(*primaryLink)) {
		p.mu.Lock()
		p.links[l.conn] = l
		p.mu.Unlock()
		p.wg.Go(func() {
			f(l)
			p.mu.Lock()
			delete(p.links, l.conn)
			p.mu.Unlock()
			if !s.isHandedOver() { // 渡した接続は、次の serve が持っている。こちらの fd はプロセスと一緒に閉じる
				l.conn.Close()
			}
		})
	}
	for _, l := range links {
		run(l, s.followShj)
	}
	p.wg.Go(func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				if errors.Is(err, os.ErrDeadlineExceeded) && !s.waitHandover() {
					continue // 引き継ぎが失敗した。受け直す
				}
				return
			}
			run(newPrimaryLink(c, nil), s.primaryConn)
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
	for c := range p.links {
		c.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
}

// MinPrimaryProtocol と MaxPrimaryProtocol は、kisui が受ける shj → kisui の通信の版の範囲
// （docs/protocol.md）。版のない今までの shj は 0。範囲の外の名乗りは断る。
const (
	MinPrimaryProtocol = 0
	MaxPrimaryProtocol = ctl.PrimaryProtocol
)

// primaryConn は 1 本の接続。名乗りを受けて、切れるまで読む（followShj）。
func (s *Server) primaryConn(l *primaryLink) {
	c := l.conn
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	first, err := l.readLine()
	if err != nil {
		reply(c, errors.New("no hello"))
		return
	}
	var op struct {
		Op  string `json:"op"`
		Cmd string `json:"cmd"`
	}
	if json.Unmarshal(first, &op) == nil && op.Op != "" {
		s.paneConn(c, first)
		return
	}
	if op.Cmd != "" { // 欄の中のコマンド（kisui open など。panecmd.go）
		s.paneCmdConn(c, first)
		return
	}
	var h ctl.PrimaryHello
	if err := json.Unmarshal(first, &h); err != nil {
		reply(c, err)
		return
	}
	if h.Protocol < MinPrimaryProtocol || h.Protocol > MaxPrimaryProtocol {
		r := ctl.PrimaryReply{
			Error: fmt.Sprintf("unsupported protocol version %d (supported: %d to %d)", h.Protocol, MinPrimaryProtocol, MaxPrimaryProtocol),
			Code:  ctl.ReplyCodeVersion, Min: MinPrimaryProtocol, Max: MaxPrimaryProtocol,
		}
		b, _ := json.Marshal(r)
		_, _ = c.Write(append(b, '\n'))
		return
	}
	// 名乗りを受けるのと、引き継ぎで渡す接続を決めるのを 1 つずつにする。
	s.opMu.RLock()
	if s.isHandedOver() {
		s.opMu.RUnlock()
		reply(c, errHandedOver)
		return
	}
	claim, err := s.ws.claimShj(h)
	if err != nil {
		s.opMu.RUnlock()
		reply(c, err)
		return
	}
	reply(c, nil)
	_ = c.SetReadDeadline(time.Time{})
	l.mu.Lock()
	l.claim = claim
	l.mu.Unlock()
	s.opMu.RUnlock()
	s.followShj(l)
}

// followShj は名乗った shj の接続を、切れるまで読む。名乗りのあとに来る 1 行ずつの ctl.PrimaryFile は、
// その shj が出しているファイル。読めない行は捨てる。切れたら（shj が終わったら）その shj を忘れる。
func (s *Server) followShj(l *primaryLink) {
	for {
		line, err := l.readLine()
		if errors.Is(err, errPrimaryLineTooLong) {
			continue // 長すぎる行はその行だけ捨てる（接続は切らない。切ると shj を忘れてしまう）
		}
		if err == nil {
			var f ctl.PrimaryFile
			if json.Unmarshal(line, &f) == nil && (f.File == "" || filepath.IsAbs(f.File)) {
				s.ws.setShjState(l.claim, f.File, cleanDiff(f.Diff))
			}
			continue
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			if !l.pause.park() {
				_ = l.conn.SetReadDeadline(time.Time{}) // 止めるのをやめたあとに残った期限
			}
			continue
		}
		break
	}
	l.end()
	// 引き継ぎの最中に切れたら、結果を待つ。渡したあとは次の serve が忘れる。
	s.opMu.RLock()
	defer s.opMu.RUnlock()
	if !s.isHandedOver() {
		s.ws.releaseShj(l.claim)
	}
}

func reply(c net.Conn, err error) {
	r := ctl.PrimaryReply{OK: err == nil, Changes: err == nil, ChangesPR: err == nil}
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

// releaseShj は claim の shj が終わったことを覚え、その shj が開いた欄を閉じる。別の shj に替わっていれば何もしない。
// ワークスペースが先に消えていても、リンクは claim の wsID から消す。
func (w *wsManager) releaseShj(claim *primaryShj) {
	w.mu.Lock()
	panes := claim.panes
	claim.panes = nil
	claim.extras = nil
	for _, st := range w.reg {
		if st.shj == claim {
			st.shj = nil
		}
	}
	w.mu.Unlock()
	w.unlinkShj(claim)
	for _, id := range panes { // この shj が開いた欄は、shj と一緒に閉じる
		w.closePane(claim, id)
	}
	w.recompute()
}

// cleanDiff は shj が送った一覧から、絶対パスでないファイルを捨てて上限に収める。nil（差分モードでない）はそのまま。
func cleanDiff(d *ctl.PrimaryDiff) *ctl.PrimaryDiff {
	if d == nil {
		return nil
	}
	out := &ctl.PrimaryDiff{Files: make([]ctl.DiffFile, 0, len(d.Files))}
	if d.Base == ctl.BasePR {
		out.Base = ctl.BasePR // 知らない値は HEAD（空）にする
	}
	for _, f := range d.Files {
		if !filepath.IsAbs(f.Path) {
			continue
		}
		if len(out.Files) == maxDiffFiles {
			break
		}
		f.Viewed = f.Viewed && out.Base == ctl.BasePR // viewed は PR モードのときだけ
		out.Files = append(out.Files, f)
	}
	if filepath.IsAbs(d.Selected) {
		out.Selected = d.Selected
	}
	return out
}

func diffEq(a, b *ctl.PrimaryDiff) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Selected == b.Selected && a.Base == b.Base && slices.Equal(a.Files, b.Files)
}

// setShjState は claim の shj が出しているファイルと、差分モードの一覧（diff。差分モードでなければ nil）を覚え、
// 変わっていれば GUI に知らせる。別の shj に替わっていれば何もしない。
func (w *wsManager) setShjState(claim *primaryShj, file string, diff *ctl.PrimaryDiff) {
	w.mu.Lock()
	changed := false
	for _, st := range w.reg {
		if st.shj == claim && (claim.File != file || !diffEq(claim.Diff, diff)) {
			claim.File, claim.Diff = file, diff
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
// path はワークスペースのルートからの相対パス（checkFile の検査：ルートの中にあるファイルか）。プライマリに shj がいなければ not_found。
func (ss *session) primaryRequest(req *rpc.Message) (res any, err error, handled bool) {
	if req.Method == "shj.diff" {
		res, err := ss.shjDiff(req)
		return res, err, true
	}
	if req.Method == "shj.changesKey" {
		res, err := ss.shjChangesKey(req)
		return res, err, true
	}
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
	if err := askShj(sock, ctl.Request{Cmd: "open", Path: full}); err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "%v", err), true
	}
	return struct{}{}, nil, true
}

// shjDiff は shj.diff。サイドバーの CHANGES で選んだファイルの差分を、プライマリの shj に出させる。
// path は primaryShj.diff.files の path（絶対パス）で、その shj が今の一覧に載せているものだけを通す。
// 削除されたファイルもあるので、ファイルの有無は調べない。差分モードでなければ not_found。
func (ss *session) shjDiff(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var p struct {
		WorkspaceID string `json:"workspaceId"`
		Path        string `json:"path"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	w := ss.srv.ws
	w.mu.Lock()
	var sock string
	listed := false
	if st := w.reg[p.WorkspaceID]; st != nil && st.shj != nil {
		sock = st.shj.Socket
		if d := st.shj.Diff; d != nil {
			listed = slices.ContainsFunc(d.Files, func(f ctl.DiffFile) bool { return f.Path == p.Path })
		}
	}
	w.mu.Unlock()
	if sock == "" {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no shj in the primary terminal of %s", p.WorkspaceID)
	}
	if !listed {
		return nil, rpc.Errorf(rpc.CodeNotFound, "not in the list of changes: %s", p.Path)
	}
	if err := askShj(sock, ctl.Request{Cmd: "diff", Path: p.Path}); err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	return struct{}{}, nil
}

// validChangesKey は shj.changesKey で shj に渡せるキーか：TUI の CHANGES の s（split / unified）・r・R（読み直す）・
// space（Space メニュー）・:（コマンド行）。続きのキーは端末から shj に届く。
// 動き・開閉などのキーは GUI が受け持つので、ここには無い。
func validChangesKey(k string) bool {
	switch k {
	case "s", "r", "R", "space", ":":
		return true
	}
	return false
}

// shjChangesKey は shj.changesKey。サイドバーの CHANGES で押した s・r・R・Space・: を、プライマリの shj に
// 「CHANGES にフォーカスがあるときに押した」ものとして受けさせる（ctl の changes-key。動きは shj の handleChangesKey が決める）。
// 差分モードでなければ not_found。
func (ss *session) shjChangesKey(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var p struct {
		WorkspaceID string `json:"workspaceId"`
		Key         string `json:"key"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	if !validChangesKey(p.Key) {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "not a key of the changes list: %q", p.Key)
	}
	w := ss.srv.ws
	w.mu.Lock()
	var sock string
	diffMode := false
	if st := w.reg[p.WorkspaceID]; st != nil && st.shj != nil {
		sock = st.shj.Socket
		diffMode = st.shj.Diff != nil
	}
	w.mu.Unlock()
	if sock == "" || !diffMode {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no shj in diff mode in the primary terminal of %s", p.WorkspaceID)
	}
	if err := askShj(sock, ctl.Request{Cmd: "changes-key", Line: p.Key}); err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	return struct{}{}, nil
}

// askShj は shj の制御用ソケット（core/ctl）に req を頼む。
func askShj(sock string, req ctl.Request) error {
	c, err := net.DialTimeout("unix", sock, shjOpenTimeout)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(shjOpenTimeout))
	if err := json.NewEncoder(c).Encode(req); err != nil {
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
// リンクの先は、ソケット自身が ctl.SocketPath の規則どおり kisui serve と同じディレクトリにあるものだけ。
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

func invalidParams(err error) *rpc.Error {
	return rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
}

// checkFile は full（root の中の rel）が、root の中にあるファイルなのを確かめる。
func checkFile(root, full, rel string) error {
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return rpc.Errorf(rpc.CodeNotFound, "no such file: %s", rel)
		}
		return rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	if !within(root, real) {
		return errDenied(rel)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return fsError(err)
	}
	if fi.IsDir() {
		return rpc.Errorf(rpc.CodeInvalidParams, "not a file: %s", rel)
	}
	return nil
}
