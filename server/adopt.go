package server

// 引き継ぎの、新しい serve の側（`kisui serve --handover`）。手順は handover.go の先頭を見る。

import (
	"errors"
	"fmt"
	"net"
	"os"
	"slices"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/emulator"
)

// adoptStateTimeout は、hello を送ってから状態が届くまで待つ時間。
const adoptStateTimeout = 2 * time.Minute

// adoption は前の serve から受け取って、Serve で動かし始めるもの。
type adoption struct {
	primaryLn   *net.UnixListener // nil なら serve-primary.rpc を新しく開く
	primaryPath string
	links       []*primaryLink // 名乗った shj の接続
	gone        []*primaryShj  // 接続を受け取らなかった shj（前の serve の中で切れた）。Serve で忘れる
}

// Adopt は、fd 3（f）でつながった古い serve から状態を受け取って、引き継いだ Server を作る。
// 返した Server は Serve で動かし始める（PTY と shj の接続を読み、待ち受ける）。失敗したら、古い serve が
// 動き続けるので、受け取った fd は閉じるだけにする（シェルに合図は送らない）。
func Adopt(opts Options, f *os.File) (*Server, error) {
	c, err := net.FileConn(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	conn, ok := c.(*net.UnixConn)
	if !ok {
		c.Close()
		return nil, errors.New("handover: fd 3 is not a Unix socket")
	}
	defer conn.Close()
	// wasm のコンパイルは、古い serve を止める前に済ませておく（止めている時間を短くする）。
	if em, err := emulator.New(1, 1); err == nil {
		em.Close()
	}
	if err := writeFrame(conn, handoverMsg{Type: "hello", Versions: handoverVersions}); err != nil {
		return nil, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(adoptStateTimeout))
	var m handoverMsg
	if err := readFrame(conn, &m); err != nil {
		return nil, fmt.Errorf("handover: %w", err)
	}
	if m.Type == "error" {
		return nil, fmt.Errorf("handover: the old kisui serve refused: %s", m.Error)
	}
	if m.Type != "state" || m.State == nil {
		return nil, fmt.Errorf("handover: unexpected message %q", m.Type)
	}
	fds, err := recvFDs(conn, m.State.FDs)
	if err != nil {
		return nil, fmt.Errorf("handover: %w", err)
	}
	srv, err := adoptState(opts, m.State, fds)
	if err != nil {
		_ = writeFrame(conn, handoverMsg{Type: "error", Error: err.Error()})
		return nil, fmt.Errorf("handover: %w", err)
	}
	if err := writeFrame(conn, handoverMsg{Type: "ready", PID: os.Getpid()}); err != nil {
		srv.dropAdopted()
		return nil, fmt.Errorf("handover: %w", err)
	}
	// go が来るか、古い serve が終わって接続が閉じたら、こちらのもの。引き継ぎをやめるとき、古い serve は
	// このプロセスを SIGKILL で止めるので、ここから先へは進まない。
	_ = conn.SetReadDeadline(time.Time{})
	var g handoverMsg
	_ = readFrame(conn, &g)
	srv.log.Info("handover: adopted", "terminals", len(m.State.Terms), "workspaces", len(m.State.Workspaces))
	return srv, nil
}

// adoptState は受け取った状態から Server を作る。まだ何も読まない。失敗したら受け取った fd を全部閉じる。
func adoptState(opts Options, st *handoverState, fds []int) (_ *Server, err error) {
	var srv *Server
	used := make([]bool, len(fds))
	defer func() {
		if err != nil {
			for i, fd := range fds {
				if !used[i] {
					closeFD(fd)
				}
			}
			if srv != nil {
				srv.dropAdopted()
			}
		}
	}()
	if !slices.Contains(handoverVersions, st.Version) {
		return nil, fmt.Errorf("unsupported handover version %d", st.Version)
	}
	if st.SocketPath != opts.SocketPath {
		return nil, fmt.Errorf("socket differs: the old kisui serve listens on %s, this one would on %s", st.SocketPath, opts.SocketPath)
	}
	if len(fds) != st.FDs {
		return nil, fmt.Errorf("got %d file descriptors, want %d", len(fds), st.FDs)
	}
	file := func(i int, name string) (*os.File, error) {
		if i < 0 || i >= len(fds) || used[i] {
			return nil, fmt.Errorf("bad file descriptor index %d", i)
		}
		used[i] = true
		return os.NewFile(uintptr(fds[i]), name), nil
	}
	listener := func(i int, name string) (*net.UnixListener, error) {
		f, err := file(i, name)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		ln, err := net.FileListener(f)
		if err != nil {
			return nil, err
		}
		ul, ok := ln.(*net.UnixListener)
		if !ok {
			ln.Close()
			return nil, fmt.Errorf("%s is not a Unix socket", name)
		}
		ul.SetUnlinkOnClose(true) // 自分で作ったときと同じく、閉じたら消す
		return ul, nil
	}

	ln, err := listener(st.Listener, "serve.rpc")
	if err != nil {
		return nil, err
	}
	srv = newServer(opts, ln)
	srv.serverID, srv.startedAt, srv.lastClient, srv.rev = st.ServerID, st.StartedAt, st.LastClient, st.Rev
	ad := &adoption{}
	srv.adopted = ad

	// ターミナル
	m := srv.terms
	m.next = st.NextTerm
	for _, ht := range st.Terms {
		if ht.Cols <= 0 || ht.Rows <= 0 || ht.RingStart < 0 || ht.RingStart+int64(len(ht.Ring)) < ht.RingStart {
			return nil, fmt.Errorf("terminal %s: bad state", ht.ID)
		}
		t := &terminal{
			mgr: m, id: ht.ID, pid: ht.PID, cwd: ht.Cwd, wsID: ht.Workspace, primary: ht.Primary,
			cols: ht.Cols, rows: ht.Rows, title: ht.Title, alive: ht.Alive,
			ring: make([]byte, ringSize), base: ht.RingStart, total: ht.RingStart,
			feed: newScreenFeed(srv.log, ht.Rows, ht.Cols),
		}
		t.ringAppend(ht.Ring)
		t.sent = min(max(ht.Sent, t.base), t.total)
		t.acked = min(max(ht.Acked, t.base), t.total)
		if len(ht.Screen) > 0 {
			t.feed.write(ht.Screen)
		}
		m.terms[t.id] = t // 失敗したときに dropAdopted が閉じられるよう、先に入れる
		if ht.Alive {
			f, err := file(ht.FD, "/dev/ptmx")
			if err != nil {
				return nil, fmt.Errorf("terminal %s: %w", ht.ID, err)
			}
			t.ptmx = pollable(f, srv.log)
			// このサーバーの子ではないので、合図は pid に送り、終わりは PTY の EOF のあとプロセスが無くなるので知る。
			// Linux の os.FindProcess は pidfd を使うので、pid が使い回されても別のプロセスに合図しない。
			if p, err := os.FindProcess(ht.PID); err == nil {
				t.process = p
			}
		}
	}

	// ワークスペース
	w := srv.ws
	w.next, w.nextExtra, w.focus = st.NextWorkspace, st.NextExtra, st.Focus
	for _, hw := range st.Workspaces {
		x := &wsState{id: hw.ID, seq: hw.Seq, root: hw.Root, kind: hw.Kind, primary: hw.Primary}
		if hw.Shj != nil {
			x.shj = &primaryShj{Socket: hw.Shj.Socket, PID: hw.Shj.PID, File: hw.Shj.File, wsID: hw.ID,
				panes: slices.Clone(hw.Shj.Panes), extras: slices.Clone(hw.Shj.Extras)}
		}
		w.reg[x.id] = x
	}

	// serve-primary.rpc と、名乗った shj の接続
	if st.PrimaryLn >= 0 {
		if ad.primaryLn, err = listener(st.PrimaryLn, "serve-primary.rpc"); err != nil {
			return nil, err
		}
		ad.primaryPath = st.PrimaryPath
	}
	linked := map[string]bool{}
	for _, hl := range st.Links {
		f, err := file(hl.FD, "shj")
		if err != nil {
			return nil, err
		}
		c, err := net.FileConn(f)
		f.Close()
		if err != nil {
			return nil, err
		}
		x := w.reg[hl.Workspace]
		if x == nil || x.shj == nil || linked[hl.Workspace] {
			c.Close() // 渡されても持ち主がいない。切れば shj はつなぎ直さずに終わったことになる
			continue
		}
		l := newPrimaryLink(c, hl.Pending)
		l.claim = x.shj
		ad.links = append(ad.links, l)
		linked[hl.Workspace] = true
	}
	for id, x := range w.reg {
		if x.shj != nil && !linked[id] {
			ad.gone = append(ad.gone, x.shj)
		}
	}

	// ツリーの監視
	if st.Tree != nil {
		srv.tree.w.ws = st.Tree
	}
	srv.tree.rev.Store(st.TreeRev)
	srv.tree.gitRev.Store(st.GitRev)
	return srv, nil
}

// startAdopted は引き継いだものを動かし始める（Serve から、接続を受ける前に呼ぶ）。
func (s *Server) startAdopted(ad *adoption) {
	m := s.terms
	m.mu.Lock()
	for _, t := range m.terms {
		if t.isAlive() {
			t.startPump()
		}
	}
	m.mu.Unlock()
	if ad.primaryLn != nil {
		s.servePrimary(ad.primaryLn, ad.primaryPath, ad.links)
	} else {
		s.startPrimary()
	}
	s.ws.recompute()
	for _, claim := range ad.gone {
		s.ws.releaseShj(claim)
	}
}

// dropAdopted は、動かし始める前にやめたときに、受け取ったものを閉じる（シェルに合図は送らない）。
func (s *Server) dropAdopted() {
	for _, t := range s.terms.all() {
		t.feed.close()
		if t.ptmx != nil {
			t.ptmx.Close()
		}
	}
	s.ln.SetUnlinkOnClose(false)
	s.ln.Close()
	if ad := s.adopted; ad != nil {
		if ad.primaryLn != nil {
			ad.primaryLn.SetUnlinkOnClose(false)
			ad.primaryLn.Close()
		}
		for _, l := range ad.links {
			l.conn.Close()
		}
	}
}

func closeFD(fd int) { _ = os.NewFile(uintptr(fd), "").Close() }
