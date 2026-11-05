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
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mm1995tk/shijimi-editor/core/ctl"
)

// primaryShj はプライマリターミナルで動いている shj。GUI へは workspace の primaryShj で届く。
type primaryShj struct {
	// Socket はその shj の制御用ソケット（core/ctl）の場所。
	Socket string `json:"socket"`
	PID    int    `json:"pid"`
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

// primaryConn は 1 本の接続。名乗りを受けて、切れるまで待つ。
func (s *Server) primaryConn(c net.Conn) {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(io.LimitReader(c, 64<<10))
	var h ctl.PrimaryHello
	if err := json.NewDecoder(br).Decode(&h); err != nil {
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
	_, _ = io.Copy(io.Discard, c) // 何も読まない。切れたら戻る
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
	claim := &primaryShj{Socket: h.Socket, PID: h.PID}
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
	w.recompute()
	return claim, nil
}

// releaseShj は claim の shj が終わったことを覚える。別の shj に替わっていれば何もしない。
func (w *wsManager) releaseShj(claim *primaryShj) {
	w.mu.Lock()
	for _, st := range w.reg {
		if st.shj == claim {
			st.shj = nil
		}
	}
	w.mu.Unlock()
	w.recompute()
}
