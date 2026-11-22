package proxy

// 通信を途中で止める（#411）。止めるのを入れている間は、クライアントの要求を行き先に送る前に止め、記録に「止めている」
// （StateHeld）通信として出す。窓のパネルが、そのまま流す・書き換えて流す・捨てる、を決める（Release）。
// 止めるのは要求だけ（応答は止めない）。プロキシから送り直す要求（Resend）は止めない。

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// MaxHeld は、1 つのプロキシで同時に止めている要求の数の上限。超えた要求は、空くまで待つ（止めずに流しはしない）。
const MaxHeld = 100

// ErrNotHeld は、その通信を止めていない（もう流した・捨てた・クライアントが待つのをやめた・止めるのをやめた）。
var ErrNotHeld = errors.New("the request is not held")

// 止めた要求を、行き先に送らずに終えたときに、記録（Summary.Error）に残す理由。
const (
	errDropped    = "dropped in the proxy panel"
	errClientGone = "the client stopped waiting while the request was held"
	errClosed     = "the proxy was closed while the request was held"
)

// Release は、止めている要求をどうするか。
type Release struct {
	// ID は止めている通信の id。
	ID int64
	// Drop は、行き先に送らずに捨てる（クライアントには 502 を返す）。
	Drop bool
	// Edit は、書き換えて流すときの、送る要求（From は見ない）。nil なら、そのまま流す。形は Resend と同じ：
	// Body が nil なら、元の本文をそのまま送る。ConnectTo は、URL のホストと違う所につなぐときのつなぐ先。
	Edit *Resend
}

// holder は、止めるのを入れているかと、止めている要求。
type holder struct {
	mu sync.Mutex
	on bool
	// off は、止めるのをやめたときに閉じる（入れるたびに作り直す）。止めている要求は、これが閉じたらそのまま流れる
	off   chan struct{}
	held  map[int64]*heldRequest
	slots counter
}

// heldRequest は止めている要求 1 つ。
type heldRequest struct {
	decide chan decision // 決まったことを 1 つだけ受ける
	// body は、止める前に読んだ本文。unread なら読んでいない（大きさが分からない・MaxBody より大きい。そのまま流す）
	body   Body
	unread bool
}

// decision は、止めた要求の決まったこと。drop でも edit でもなければ、そのまま流す。
type decision struct {
	drop bool
	edit *editedRequest
}

// editedRequest は、書き換えて流す要求（prepare で確かめたもの）。
type editedRequest struct {
	req  *http.Request
	dial string
	// body は送る本文。keepStream なら、読んでいない元の本文をそのまま送る（body は見ない）
	body       []byte
	keepStream bool
}

func newHolder() holder {
	return holder{held: map[int64]*heldRequest{}, slots: newCounter(MaxHeld)}
}

// SetHold は、クライアントの要求を行き先に送る前に止めるかを切り替える。false にすると、止めている要求は
// そのまま流れる。記録していない間（Store が無い・SetIntercept(false)）は、入れていても止めない。
func (p *Proxy) SetHold(on bool) {
	h := &p.hold
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.on == on {
		return
	}
	h.on = on
	if on {
		h.off = make(chan struct{})
	} else {
		close(h.off)
	}
}

// Holding は、要求を止めるのを入れているか。
func (p *Proxy) Holding() bool {
	h := &p.hold
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.on
}

// Release は、止めている要求 r.ID を、そのまま流す・書き換えて流す・捨てる。止めていなければ ErrNotHeld、
// 書き換えた要求の形が違えば InvalidRequestError（要求は止めたまま）。
func (p *Proxy) Release(r Release) error {
	h := &p.hold
	h.mu.Lock()
	hr := h.held[r.ID]
	h.mu.Unlock()
	if hr == nil {
		return ErrNotHeld
	}
	var d decision
	switch {
	case r.Drop:
		d.drop = true
	case r.Edit != nil:
		// 止めた本文は切れていない（MaxBody までしか読まない）ので、ErrBodyCut にはならない
		req, dial, err := p.prepare(*r.Edit, hr.body)
		if err != nil {
			return err
		}
		e := &editedRequest{req: req, dial: dial, body: hr.body.Data, keepStream: hr.unread}
		if r.Edit.Body != nil {
			e.body, e.keepStream = *r.Edit.Body, false
		}
		d.edit = e
	}
	h.mu.Lock()
	if h.held[r.ID] != hr {
		h.mu.Unlock()
		return ErrNotHeld
	}
	delete(h.held, r.ID)
	h.mu.Unlock()
	hr.decide <- d
	return nil
}

// holdRequest は、止めるのを入れていれば、要求 r を止めて、決まるまで待つ。記録（ex.flow）も始める。
// 行き先に送る要求（書き換えたものか、r）を返す。false は、もう答えた・クライアントがいない（送らない）。
// 待っている間にプロキシが閉じたら（Close）、応答を書かずに接続を切る（http.ErrAbortHandler の panic）。何も書かずに
// 戻ると、net/http が中身の無い 200 を返し、行き先に送っていない要求が、クライアントからは成功に見えるため。
func (p *Proxy) holdRequest(w http.ResponseWriter, r *http.Request, ex *exchange) (*http.Request, bool) {
	h := &p.hold
	h.mu.Lock()
	on, off := h.on, h.off
	h.mu.Unlock()
	begin := func() (*http.Request, bool) {
		ex.flow = p.store.begin(r, ex.scheme, ex.host, ex.dial)
		return r, true
	}
	if !on {
		return begin()
	}
	// 止めている数が上限なら、空くまで待つ
	select {
	case h.slots.ch <- struct{}{}:
	case <-off:
		return begin()
	case <-r.Context().Done():
		return nil, false
	case <-p.done:
		panic(http.ErrAbortHandler)
	}
	defer h.slots.release()

	hr, ok := readHeldBody(w, r)
	if !ok {
		return nil, false
	}
	f, held := p.beginHeld(r, ex, hr, off)
	ex.flow = f
	if !held {
		return r, true // 本文を読んでいる間に、止めるのをやめた
	}
	ex.bodyKept = !hr.unread

	d, end := p.awaitDecision(r, hr, f.id, off)
	switch {
	case end == errClosed:
		p.endHeld(f, errClosed)
		panic(http.ErrAbortHandler)
	case end != "":
		p.endHeld(f, end)
		return nil, false
	case d.drop:
		p.endHeld(f, errDropped)
		http.Error(w, "kisui proxy: the request was dropped in the proxy panel", http.StatusBadGateway)
		return nil, false
	case d.edit == nil:
		p.store.update(f, func(f *flow) { f.state = StatePending })
		return r, true
	}
	return p.applyEdit(r, ex, d.edit), true
}

// readHeldBody は、止める要求 r の本文を、大きさが分かっていて MaxBody までなら、先に読む（パネルで見て書き換えられる
// ように。r.Body は、読んだものを読み直せるものに替える）。大きさが分からない（終わらないかもしれない）・大きい本文は
// 読まない（unread。そのまま流す）。HTTP/1.1 では、本文を読み終えるまで net/http が接続の切れたのを見張らないので、
// 読まずに止めた要求は、クライアントが待つのをやめても held のまま残る（流す・捨てる・止めるのをやめると片付く）。
// 読めなければ、400 を答えて false。
func readHeldBody(w http.ResponseWriter, r *http.Request) (*heldRequest, bool) {
	hr := &heldRequest{decide: make(chan decision, 1)}
	switch {
	case r.ContentLength == 0 || r.Body == nil || r.Body == http.NoBody:
	case r.ContentLength > 0 && r.ContentLength <= MaxBody:
		data, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "kisui proxy: cannot read the body of the request", http.StatusBadRequest)
			return nil, false
		}
		hr.body = Body{Data: data, Size: int64(len(data))}
		r.Body = io.NopCloser(bytes.NewReader(data))
	default:
		hr.unread = true
	}
	return hr, true
}

// beginHeld は、要求 r を記録に足し、止めている要求 hr として覚える。この 2 つを同時にする（知らせを受けた窓が、
// すぐに Release できるように）。off は、止め始めたときの holder.off。もう止めるのをやめていたら、覚えずに、
// ふつうの通信として足して false。
func (p *Proxy) beginHeld(r *http.Request, ex *exchange, hr *heldRequest, off chan struct{}) (*flow, bool) {
	h := &p.hold
	held := false
	f := p.store.beginWith(r, ex.scheme, ex.host, ex.dial, func(f *flow) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.off != off {
			return
		}
		f.state, f.reqBody, f.bodyUnread = StateHeld, hr.body, hr.unread
		h.held[f.id] = hr
		held = true
	})
	return f, held
}

// awaitDecision は、止めている要求 hr（通信 id）の決まったことを待ち、止めている要求から外す。止めるのをやめたら
// （off）、そのまま流す決まり（空の decision）を返す。end は、決まる前に終わった理由（errClientGone：クライアントが
// 待つのをやめた、errClosed：プロキシを閉じた）で、"" なら決まった。Release が同時に決めていたら、そちらを受け取る
// （Release に「流した」と答えたものを、落とさない）。
func (p *Proxy) awaitDecision(r *http.Request, hr *heldRequest, id int64, off chan struct{}) (d decision, end string) {
	h := &p.hold
	select {
	case d = <-hr.decide:
		return d, ""
	case <-off:
	case <-r.Context().Done():
		end = errClientGone
	case <-p.done:
		end = errClosed
	}
	h.mu.Lock()
	taken := h.held[id] != hr
	delete(h.held, id)
	h.mu.Unlock()
	if taken {
		// Release が外していた。決まったことは、必ず届く
		d = <-hr.decide
	}
	return d, end
}

// endHeld は、止めた要求を、行き先に送らずに終える（記録は failed）。
func (p *Proxy) endHeld(f *flow, reason string) {
	p.store.update(f, func(f *flow) {
		f.state, f.err, f.duration = StateFailed, reason, time.Since(f.start)
	})
}

// applyEdit は、止めた要求 r を e のとおりに書き換えた要求を作り、行き先（ex）と記録も合わせる。
func (p *Proxy) applyEdit(r *http.Request, ex *exchange, e *editedRequest) *http.Request {
	out := r.Clone(r.Context())
	out.Method = e.req.Method
	// scheme と host は、rewrite が ex から入れる
	out.URL = &url.URL{Path: e.req.URL.Path, RawPath: e.req.URL.RawPath, RawQuery: e.req.URL.RawQuery}
	out.Host = e.req.Host
	out.Header = e.req.Header.Clone()
	if !e.keepStream {
		out.TransferEncoding = nil
		out.ContentLength = int64(len(e.body))
		out.Body = http.NoBody
		if len(e.body) > 0 {
			out.Body = io.NopCloser(bytes.NewReader(e.body))
		}
		ex.bodyKept = true
	}
	ex.scheme, ex.host, ex.dial = e.req.URL.Scheme, e.req.URL.Host, e.dial
	recorded := e.req.Header.Clone()
	recorded.Set("Host", e.req.Host)
	p.store.update(ex.flow, func(f *flow) {
		f.state, f.edited = StatePending, true
		f.method, f.scheme, f.host, f.path = e.req.Method, ex.scheme, ex.host, e.req.URL.RequestURI()
		f.reqHeader, f.dial = recorded, e.dial
		if !e.keepStream {
			f.reqBody = Body{Data: e.body, Size: int64(len(e.body))}
		}
	})
	return out
}
