package server

import "sync"

// pauser は、読みの goroutine（PTY の pump と、名乗った shj の接続の読み）を引き継ぎ（handover.go）のために
// 止める仕組み。止める側は request で頼んでから読みの期限を過去にし、parked を待つ。読みの側は期限切れで park を
// 呼んで止まり、release されたら読み直す。読みが終わった goroutine は end で、待っている側を起こす。
type pauser struct {
	mu      sync.Mutex
	pausing bool
	parked  chan struct{} // 止まったか、読みが終わったら閉じる
	resume  chan struct{} // 閉じると読み直す
}

// request は止めるよう頼む。parked は止まったら閉じる。release は、clear（読みの期限を消す）を呼んでから読み直させる。
func (p *pauser) request(clear func()) (parked <-chan struct{}, release func()) {
	p.mu.Lock()
	p.pausing, p.parked, p.resume = true, make(chan struct{}), make(chan struct{})
	parkedCh, resume := p.parked, p.resume
	p.mu.Unlock()
	return parkedCh, func() {
		clear()
		p.mu.Lock()
		p.pausing = false
		p.mu.Unlock()
		close(resume)
	}
}

// park は、止めるよう頼まれていれば止まったことを知らせて release まで待ち、true を返す。
// 頼まれていなければ（release のあとに残った期限切れ）すぐ false を返す。
func (p *pauser) park() bool {
	p.mu.Lock()
	if !p.pausing {
		p.mu.Unlock()
		return false
	}
	parked, resume := p.parked, p.resume
	p.pausing = false // 止まったことは 1 度だけ知らせる
	p.mu.Unlock()
	close(parked)
	<-resume
	return true
}

// end は読みが終わったことを知らせる。止めるよう頼まれていれば、待っている側を起こす。
func (p *pauser) end() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pausing {
		p.pausing = false
		close(p.parked)
	}
}
