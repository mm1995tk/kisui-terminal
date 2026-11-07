package server

// 引き継ぎで、古い serve の仕事を止める（handover.go の手順の 2）。

import (
	"errors"
	"fmt"
	"net"
	"slices"
	"time"
)

// pastDeadline は読みと accept をすぐ止める期限。
var pastDeadline = time.Unix(1, 0)

// undoList は、止めたものを戻す処理を、止めたのと逆の順に呼ぶ。
type undoList []func()

func (u *undoList) add(f func()) { *u = append(*u, f) }

func (u undoList) run() {
	for _, v := range slices.Backward(u) {
		v()
	}
}

// freeze は、状態を変えるものを止める。s.opMu の書きロックを持って呼ぶ（GUI の要求などはもう止まっている）。
// 待ち受け・名乗った shj の接続・PTY の読みを、読みの期限で止める（閉じない）。戻すときは unfreeze を呼ぶ。
func (s *Server) freeze() (unfreeze func(), err error) {
	var undo undoList
	for _, pause := range []func(*undoList) error{s.pauseListeners, s.pauseLinks, s.pauseTerms} {
		if err := pause(&undo); err != nil {
			undo.run()
			return nil, err
		}
	}
	return undo.run, nil
}

// pauseListeners は serve.rpc と serve-primary.rpc の accept を止める。閉じても消さないようにしておく。
func (s *Server) pauseListeners(undo *undoList) error {
	s.mu.Lock()
	p := s.primary
	s.mu.Unlock()
	lns := []*net.UnixListener{s.ln}
	if p != nil {
		lns = append(lns, p.ln)
	}
	for _, ln := range lns {
		ln.SetUnlinkOnClose(false)
		undo.add(func() { ln.SetUnlinkOnClose(true) })
		if err := ln.SetDeadline(pastDeadline); err != nil {
			return err
		}
		undo.add(func() { _ = ln.SetDeadline(time.Time{}) })
	}
	return nil
}

// pauseLinks は名乗った shj の接続の読みを止める。名乗る前の接続と、もう切れた接続は止めない（渡さない）。
func (s *Server) pauseLinks(undo *undoList) error {
	s.mu.Lock()
	p := s.primary
	s.mu.Unlock()
	if p == nil {
		return nil
	}
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
			continue
		}
		parked, release := l.pause.request(func() { _ = l.conn.SetReadDeadline(time.Time{}) })
		l.mu.Unlock()
		undo.add(release)
		if err := l.conn.SetReadDeadline(pastDeadline); err != nil {
			return err
		}
		if !waitParked(parked, nil) {
			return errors.New("a shj connection did not pause")
		}
	}
	return nil
}

// pauseTerms は PTY を読む pump を止める。pump が無い（シェルが終わった）ターミナルはそのまま。
func (s *Server) pauseTerms(undo *undoList) error {
	for _, t := range s.terms.all() {
		t.mu.Lock()
		done, ptmx := t.pumpDone, t.ptmx
		t.mu.Unlock()
		if done == nil || isClosed(done) {
			continue
		}
		parked, release := t.pause.request(func() { _ = ptmx.SetReadDeadline(time.Time{}) })
		undo.add(release)
		if err := ptmx.SetReadDeadline(pastDeadline); err != nil {
			return fmt.Errorf("terminal %s: %w", t.id, err)
		}
		if !waitParked(parked, done) {
			return fmt.Errorf("terminal %s did not pause", t.id)
		}
	}
	return nil
}

// waitParked は、止まったか（parked）、読みが終わったか（done。nil なら見ない）まで待つ。時間切れなら false。
func waitParked(parked, done <-chan struct{}) bool {
	select {
	case <-parked:
		return true
	case <-done:
		return true
	case <-time.After(handoverPauseTimeout):
		return false
	}
}

func isClosed(c <-chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}
