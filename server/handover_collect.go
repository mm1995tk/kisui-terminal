package server

// 引き継ぎで、止めた状態を新しい serve に渡す形にする（handover.go の手順の 3）。

import (
	"fmt"
	"maps"
	"net"
	"slices"
	"syscall"
)

// fdList は state のあとに送る fd の並び。持っているものの番号をそのまま使う（止めている間は閉じないので、
// 送り終えるまで有効）。Fd() は呼ばない（呼ぶと fd が blocking になり、失敗して戻したあとに困る）。
type fdList []int

// add は sc の fd を並びに足し、その位置を返す。
func (l *fdList) add(sc syscall.Conn) (int, error) {
	rc, err := sc.SyscallConn()
	if err != nil {
		return -1, err
	}
	var fd int
	if err := rc.Control(func(f uintptr) { fd = int(f) }); err != nil {
		return -1, err
	}
	*l = append(*l, fd)
	return len(*l) - 1, nil
}

// collect は、止めた状態を handoverState と、送る fd の並びにする。
func (s *Server) collect(ver int) (*handoverState, []int, error) {
	var fds fdList
	st, err := s.collectServer(ver, &fds)
	if err != nil {
		return nil, nil, err
	}
	if err := s.collectLinks(st, &fds); err != nil {
		return nil, nil, err
	}
	s.collectWorkspaces(st)
	if err := s.collectTerms(st, &fds); err != nil {
		return nil, nil, err
	}
	s.collectTree(st)
	st.FDs = len(fds)
	return st, fds, nil
}

// collectServer はサーバー全体のもの（serve.rpc の待ち受け・serverId・版・GUI の時刻）。
func (s *Server) collectServer(ver int, fds *fdList) (*handoverState, error) {
	st := &handoverState{Version: ver, SocketPath: s.opts.SocketPath, PrimaryLn: -1, ServerID: s.serverID, StartedAt: s.startedAt}
	var err error
	if st.Listener, err = fds.add(s.ln); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st.Rev = s.rev
	st.LastClient = s.lastClient
	if len(s.sessions) > 0 {
		st.LastClient = s.now() // つながっている GUI は引き継ぎのあとに切れる
	}
	return st, nil
}

// collectLinks は serve-primary.rpc の待ち受けと、止めた（名乗った）shj の接続。
func (s *Server) collectLinks(st *handoverState, fds *fdList) error {
	s.mu.Lock()
	p := s.primary
	s.mu.Unlock()
	if p == nil {
		return nil
	}
	st.PrimaryPath = p.path
	var err error
	if st.PrimaryLn, err = fds.add(p.ln); err != nil {
		return err
	}
	p.mu.Lock()
	links := slices.Collect(maps.Values(p.links))
	p.mu.Unlock()
	for _, l := range links {
		l.mu.Lock()
		claim, ended := l.claim, l.ended
		l.mu.Unlock()
		uc, ok := l.conn.(*net.UnixConn)
		if claim == nil || ended || !ok {
			continue // 渡さない。新しい serve は、接続の無い shj を終わったものとして扱う
		}
		fd, err := fds.add(uc)
		if err != nil {
			return err
		}
		st.Links = append(st.Links, handoverLink{Workspace: claim.wsID, FD: fd, Pending: l.pending()})
	}
	return nil
}

// collectWorkspaces はワークスペースとプライマリの shj。
func (s *Server) collectWorkspaces(st *handoverState) {
	w := s.ws
	w.mu.Lock()
	st.NextWorkspace, st.NextExtra, st.Focus = w.next, w.nextExtra, w.focus
	for _, x := range w.reg {
		hw := handoverWS{ID: x.id, Seq: x.seq, Root: x.root, Kind: x.kind, Primary: x.primary}
		if x.shj != nil {
			hw.Shj = &handoverShj{Socket: x.shj.Socket, PID: x.shj.PID, File: x.shj.File, Diff: x.shj.Diff,
				Panes: slices.Clone(x.shj.panes), Extras: slices.Clone(x.shj.extras)}
		}
		st.Workspaces = append(st.Workspaces, hw)
	}
	w.mu.Unlock()
	slices.SortFunc(st.Workspaces, func(a, b handoverWS) int { return a.Seq - b.Seq })
}

// collectTerms はターミナル（リング・画面の状態の書き出し・生きていれば PTY の master）。
func (s *Server) collectTerms(st *handoverState, fds *fdList) error {
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
			var err error
			if ht.FD, err = fds.add(ptmx); err != nil {
				return fmt.Errorf("terminal %s: %w", t.id, err)
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
	return nil
}

// collectTree はツリーの監視（フォルダごとの署名）と版。
func (s *Server) collectTree(st *handoverState) {
	tw := s.tree.w
	tw.mu.Lock()
	if len(tw.ws) > 0 {
		st.Tree = map[string]map[string]string{}
		for id, m := range tw.ws {
			st.Tree[id] = maps.Clone(m)
		}
	}
	tw.mu.Unlock()
	st.TreeRev, st.GitRev = s.tree.rev.Load(), s.tree.gitRev.Load()
}
