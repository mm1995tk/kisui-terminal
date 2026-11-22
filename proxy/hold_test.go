package proxy

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// waitHeld は、止めている通信が n 個になるまで待って、それらを返す（古い順）。
func waitHeld(t *testing.T, s *Store, n int) []Summary {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var held []Summary
		list := s.Summaries()
		for _, f := range list {
			if f.State == StateHeld {
				held = append(held, f)
			}
		}
		if len(held) >= n {
			return held
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %d held flows: %+v", n, list)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// answer は、クライアントが受けた応答。
type answer struct {
	status int
	body   string
	err    error
}

// send は、req を別の goroutine で送り、応答を ch に入れる。
func send(c *http.Client, req *http.Request) <-chan answer {
	ch := make(chan answer, 1)
	go func() {
		resp, err := c.Do(req)
		if err != nil {
			ch <- answer{err: err}
			return
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		ch <- answer{status: resp.StatusCode, body: string(b)}
	}()
	return ch
}

func recv(t *testing.T, ch <-chan answer) answer {
	t.Helper()
	select {
	case a := <-ch:
		return a
	case <-time.After(5 * time.Second):
		t.Fatal("the client got no answer")
		return answer{}
	}
}

// 止めるのを入れると、要求は行き先に届く前に止まり、書き換えて流すと、書き換えた要求が行き先に届く。
func TestHoldAndForwardAnEditedRequest(t *testing.T) {
	var g got
	up := httptest.NewTLSServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, upstreamPool(up))
	c := clientVia(t, addr, ca.Pool())
	p.SetHold(true)
	if !p.Holding() {
		t.Fatal("not holding")
	}

	req, _ := http.NewRequest("POST", up.URL+"/items?x=1", strings.NewReader(`{"a":1}`))
	req.Header.Set("Content-Type", "application/json")
	ch := send(c, req)
	held := waitHeld(t, store, 1)[0]
	if held.Method != "POST" || held.Path != "/items?x=1" || held.Status != 0 {
		t.Fatalf("held flow: %+v", held)
	}
	if n := g.snapshot().n; n != 0 {
		t.Fatalf("the upstream already got %d requests", n)
	}
	// 止めている間に、本文も見られる
	d, _ := store.Detail(held.ID)
	if d.ReqBody.Text == nil || *d.ReqBody.Text != `{"a":1}` || d.ReqBodyUnread {
		t.Fatalf("body of the held request: %+v", d.ReqBody)
	}

	// 形の違う書き換えは断り、止めたままにする
	var bad *InvalidRequestError
	if err := p.Release(Release{ID: held.ID, Edit: &Resend{Method: "BAD METHOD", URL: up.URL}}); !errors.As(err, &bad) {
		t.Fatalf("a bad edit: %v", err)
	}
	if len(waitHeld(t, store, 1)) != 1 {
		t.Fatal("no longer held after a bad edit")
	}

	body := []byte(`{"a":2}`)
	err := p.Release(Release{ID: held.ID, Edit: &Resend{
		Method: "PUT",
		URL:    up.URL + "/items/9?y=2",
		Header: [][2]string{{"Content-Type", "application/json"}, {"X-Test", "edited"}, {"Content-Length", "999"}},
		Body:   &body,
	}})
	if err != nil {
		t.Fatal(err)
	}
	a := recv(t, ch)
	if a.err != nil || a.status != 200 || a.body != "seen PUT /items/9" {
		t.Fatalf("the client got %+v", a)
	}
	s := g.snapshot()
	if s.n != 1 || s.method != "PUT" || s.path != "/items/9?y=2" || s.body != `{"a":2}` || s.header.Get("X-Test") != "edited" {
		t.Errorf("upstream got %d: %s %s %q %v", s.n, s.method, s.path, s.body, s.header)
	}
	list := waitDone(t, store, 1)
	f := list[0]
	if len(list) != 1 || f.ID != held.ID || f.State != StateDone || !f.Edited || f.Method != "PUT" || f.Path != "/items/9?y=2" || f.Status != 200 {
		t.Errorf("the flow after it was forwarded: %+v", list)
	}
	d, _ = store.Detail(f.ID)
	if d.ReqBody.Text == nil || *d.ReqBody.Text != `{"a":2}` || !hasHeader(d.ReqHeaders, "X-Test", "edited") {
		t.Errorf("recorded request: %+v %v", d.ReqBody, d.ReqHeaders)
	}
	if err := p.Release(Release{ID: held.ID}); !errors.Is(err, ErrNotHeld) {
		t.Errorf("releasing twice: %v", err)
	}
}

// そのまま流すと、元の要求が届く。捨てると、行き先には届かず、クライアントは 502 を受ける。
func TestHoldForwardAsIsAndDrop(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	p.SetHold(true)

	req, _ := http.NewRequest("POST", up.URL+"/a", strings.NewReader("one"))
	ch := send(c, req)
	held := waitHeld(t, store, 1)[0]
	if err := p.Release(Release{ID: held.ID}); err != nil {
		t.Fatal(err)
	}
	if a := recv(t, ch); a.err != nil || a.status != 200 || a.body != "seen POST /a" {
		t.Fatalf("the client got %+v", a)
	}
	if s := g.snapshot(); s.n != 1 || s.body != "one" {
		t.Errorf("upstream got %d %q", s.n, s.body)
	}
	if f := waitDone(t, store, 1)[0]; f.Edited || f.State != StateDone || f.ReqSize != 3 {
		t.Errorf("the forwarded flow: %+v", f)
	}

	req, _ = http.NewRequest("GET", up.URL+"/b", nil)
	ch = send(c, req)
	held = waitHeld(t, store, 1)[0]
	if err := p.Release(Release{ID: held.ID, Drop: true}); err != nil {
		t.Fatal(err)
	}
	if a := recv(t, ch); a.err != nil || a.status != http.StatusBadGateway || !strings.Contains(a.body, "dropped") {
		t.Fatalf("the client of a dropped request got %+v", a)
	}
	if s := g.snapshot(); s.n != 1 {
		t.Errorf("the upstream got the dropped request (%d)", s.n)
	}
	list := waitDone(t, store, 2)
	if f := list[1]; f.State != StateFailed || f.Error != errDropped || f.Status != 0 {
		t.Errorf("the dropped flow: %+v", f)
	}
}

// 止めるのをやめると、止めていた要求はそのまま流れ、そのあとの要求は止まらない。
func TestHoldOffForwardsWhatWasHeld(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	p.SetHold(true)

	req1, _ := http.NewRequest("GET", up.URL+"/1", nil)
	req2, _ := http.NewRequest("GET", up.URL+"/2", nil)
	ch1, ch2 := send(c, req1), send(c, req2)
	waitHeld(t, store, 2)
	p.SetHold(false)
	for _, ch := range []<-chan answer{ch1, ch2} {
		if a := recv(t, ch); a.err != nil || a.status != 200 {
			t.Fatalf("the client got %+v", a)
		}
	}
	req3, _ := http.NewRequest("GET", up.URL+"/3", nil)
	if a := recv(t, send(c, req3)); a.err != nil || a.status != 200 {
		t.Fatalf("after holding was turned off, the client got %+v", a)
	}
	for _, f := range waitDone(t, store, 3) {
		if f.State != StateDone || f.Edited {
			t.Errorf("flow: %+v", f)
		}
	}
	// 記録をやめると、止めるのもやめる
	p.SetHold(true)
	p.SetIntercept(false)
	if p.Holding() {
		t.Error("still holding after the proxy stopped recording")
	}
}

// クライアントが待つのをやめたら、止めていた通信は failed になり、流せなくなる。
func TestHeldRequestEndsWhenTheClientGivesUp(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	c.Timeout = 300 * time.Millisecond
	p.SetHold(true)

	req, _ := http.NewRequest("GET", up.URL+"/slow", nil)
	ch := send(c, req)
	held := waitHeld(t, store, 1)[0]
	if a := recv(t, ch); a.err == nil {
		t.Fatalf("the client got an answer: %+v", a)
	}
	f := waitDone(t, store, 1)[0]
	if f.State != StateFailed || f.Error != errClientGone {
		t.Errorf("the flow: %+v", f)
	}
	if err := p.Release(Release{ID: held.ID}); !errors.Is(err, ErrNotHeld) {
		t.Errorf("releasing a request whose client is gone: %v", err)
	}
	if n := g.snapshot().n; n != 0 {
		t.Errorf("the upstream got %d requests", n)
	}
}

// 大きさの分からない本文は、読まずに止める（中身には「読んでいない」と出る）。書き換えて流しても、本文はそのまま届く。
func TestHoldDoesNotReadAStreamedBody(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	p.SetHold(true)

	// io.Reader のままだと、大きさが分からないので chunked で送られる
	req, _ := http.NewRequest("POST", up.URL+"/up", io.MultiReader(strings.NewReader("stream"), strings.NewReader("ed")))
	ch := send(c, req)
	held := waitHeld(t, store, 1)[0]
	d, _ := store.Detail(held.ID)
	if !d.ReqBodyUnread || d.ReqBody.Size != 0 {
		t.Fatalf("detail of a held request with a streamed body: %+v", d)
	}
	err := p.Release(Release{ID: held.ID, Edit: &Resend{Method: "POST", URL: up.URL + "/up2", Header: [][2]string{{"X-Test", "1"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if a := recv(t, ch); a.err != nil || a.status != 200 {
		t.Fatalf("the client got %+v", a)
	}
	if s := g.snapshot(); s.path != "/up2" || s.body != "streamed" || s.header.Get("X-Test") != "1" {
		t.Errorf("upstream got %s %q", s.path, s.body)
	}
	f := waitDone(t, store, 1)[0]
	d, _ = store.Detail(f.ID)
	if d.ReqBodyUnread || d.ReqBody.Text == nil || *d.ReqBody.Text != "streamed" || !f.Edited {
		t.Errorf("the recorded body after forwarding: %+v", d.ReqBody)
	}
}

// 止めている通信は、上限を超えても記録から捨てない（パネルから流せなくならないように）。
func TestStoreKeepsHeldFlows(t *testing.T) {
	s := NewStore(nil)
	r := httptest.NewRequest("GET", "http://example.com/a", nil)
	held := s.beginWith(r, "http", "example.com", "", func(f *flow) { f.state = StateHeld })
	for range MaxFlows + 5 {
		s.begin(r, "http", "example.com", "")
	}
	list := s.Summaries()
	if len(list) != MaxFlows || list[0].ID != held.id || list[1].ID != 8 {
		t.Errorf("kept %d flows, first %d, second %d", len(list), list[0].ID, list[1].ID)
	}
}

// 送り直す要求は、止めるのを入れていても止めない。
func TestResendIsNotHeld(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	req, _ := http.NewRequest("GET", up.URL+"/a", nil)
	orig := recordOne(t, c, store, req)
	p.SetHold(true)
	if _, err := p.Resend(Resend{From: orig.ID, Method: "GET", URL: up.URL + "/again"}); err != nil {
		t.Fatal(err)
	}
	if list := waitDone(t, store, 2); list[1].State != StateDone || list[1].Path != "/again" {
		t.Errorf("the resent flow: %+v", list[1])
	}
}

// 止めている間にプロキシを閉じたら、クライアントは成功の応答を受けない（行き先に送っていないのに、中身の無い 200 が
// 返らない）。記録には、閉じたことが残る。
func TestClosingTheProxyDoesNotAnswerHeldRequests(t *testing.T) {
	for range 20 {
		var g got
		up := httptest.NewServer(http.HandlerFunc(g.handler))
		p, store, ca, addr := startProxy(t, nil)
		c := clientVia(t, addr, ca.Pool())
		p.SetHold(true)
		req, _ := http.NewRequest("POST", up.URL+"/a", strings.NewReader("one"))
		ch := send(c, req)
		held := waitHeld(t, store, 1)[0]
		p.Close()
		if a := recv(t, ch); a.err == nil {
			t.Fatalf("the client of a held request got an answer when the proxy was closed: %+v", a)
		}
		if f := waitDone(t, store, 1)[0]; f.ID != held.ID || f.State != StateFailed || f.Error != errClosed {
			t.Fatalf("the flow: %+v", f)
		}
		if n := g.snapshot().n; n != 0 {
			t.Fatalf("the upstream got %d requests", n)
		}
		up.Close()
	}
}
