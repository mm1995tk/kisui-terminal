package proxy

import (
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// got は、行き先が受けた要求。
type got struct {
	mu     sync.Mutex
	method string
	path   string
	host   string
	header http.Header
	body   string
	n      int
}

func (g *got) handler(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	g.mu.Lock()
	g.method, g.path, g.host, g.header, g.body = r.Method, r.URL.RequestURI(), r.Host, r.Header.Clone(), string(b)
	g.n++
	g.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, "seen "+r.Method+" "+r.URL.Path)
}

func (g *got) snapshot() got {
	g.mu.Lock()
	defer g.mu.Unlock()
	return got{method: g.method, path: g.path, host: g.host, header: g.header, body: g.body, n: g.n}
}

// recordOne は、クライアントの要求を 1 つプロキシに通して記録し、その通信を返す。
func recordOne(t *testing.T, c *http.Client, store *Store, req *http.Request) Summary {
	t.Helper()
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	list := waitDone(t, store, 1)
	return list[len(list)-1]
}

// 書き換えた要求を送ると、行き先がそのとおりに受け、応答が新しい通信として記録に出る（元の通信の id 付き）。
func TestResendSendsTheEditedRequest(t *testing.T) {
	var g got
	up := httptest.NewTLSServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, upstreamPool(up))
	c := clientVia(t, addr, ca.Pool())

	req, _ := http.NewRequest("POST", up.URL+"/items?x=1", strings.NewReader(`{"a":1}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Encoding", "br, gzip")
	orig := recordOne(t, c, store, req)

	body := []byte(`{"a":2}`)
	sum, err := p.Resend(Resend{
		From:   orig.ID,
		Method: "PUT",
		URL:    up.URL + "/items/9?y=2#frag",
		Header: [][2]string{{"Content-Type", "application/json"}, {"X-Test", "one"}, {"x-test", "two"}, {"Content-Length", "999"}, {"Accept-Encoding", "br, gzip"}},
		Body:   &body,
	})
	if err != nil {
		t.Fatal(err)
	}
	if sum.ResentFrom != orig.ID || sum.ID == orig.ID || sum.Method != "PUT" || sum.Path != "/items/9?y=2" {
		t.Fatalf("summary of the resent request: %+v", sum)
	}
	list := waitDone(t, store, 2)
	if len(list) != 2 {
		t.Fatalf("flows = %+v", list)
	}
	r := list[1]
	if r.ID != sum.ID || r.Status != 200 || r.State != StateDone || r.ResentFrom != orig.ID {
		t.Fatalf("the resent flow: %+v", r)
	}
	s := g.snapshot()
	if s.method != "PUT" || s.path != "/items/9?y=2" || s.body != `{"a":2}` {
		t.Errorf("upstream got %s %s %q", s.method, s.path, s.body)
	}
	if v := s.header.Values("X-Test"); len(v) != 2 || v[0] != "one" || v[1] != "two" {
		t.Errorf("X-Test upstream = %v", v)
	}
	// 本文を見せられるよう、gzip だけを頼む。書いていない User-Agent は足さない
	if ae := s.header.Get("Accept-Encoding"); ae != "gzip" {
		t.Errorf("Accept-Encoding upstream = %q", ae)
	}
	if ua, ok := s.header["User-Agent"]; ok {
		t.Errorf("User-Agent upstream = %q, want none", ua)
	}
	d, ok := store.Detail(r.ID)
	if !ok {
		t.Fatal("no detail")
	}
	if d.RespBody.Text == nil || *d.RespBody.Text != "seen PUT /items/9" {
		t.Errorf("response body = %+v", d.RespBody)
	}
	if d.ReqBody.Text == nil || *d.ReqBody.Text != `{"a":2}` {
		t.Errorf("request body = %+v", d.ReqBody)
	}
	// 記録には、書いたままのヘッダーを残す
	if !hasHeader(d.ReqHeaders, "Accept-Encoding", "br, gzip") {
		t.Errorf("recorded request headers = %v", d.ReqHeaders)
	}
}

// 本文を渡さなければ、元の通信の本文をそのまま送る。Host を書けば、URL のホストの代わりに Host として送る。
func TestResendKeepsTheBodyAndUsesTheHostHeader(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())

	raw := "\x00\x01binary"
	req, _ := http.NewRequest("POST", up.URL+"/upload", strings.NewReader(raw))
	orig := recordOne(t, c, store, req)

	if _, err := p.Resend(Resend{From: orig.ID, Method: "POST", URL: up.URL + "/upload", Header: [][2]string{{"Host", "example.test"}}}); err != nil {
		t.Fatal(err)
	}
	waitDone(t, store, 2)
	s := g.snapshot()
	if s.n != 2 || s.body != raw || s.host != "example.test" {
		t.Errorf("upstream got body %q host %q (%d requests)", s.body, s.host, s.n)
	}
}

func TestResendRefusesBadRequests(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	req, _ := http.NewRequest("GET", up.URL+"/", nil)
	orig := recordOne(t, c, store, req)

	ok := Resend{From: orig.ID, Method: "GET", URL: up.URL + "/"}
	cases := []struct {
		name string
		edit func(r *Resend)
	}{
		{"method with a space", func(r *Resend) { r.Method = "GE T" }},
		{"no method", func(r *Resend) { r.Method = "" }},
		{"relative URL", func(r *Resend) { r.URL = "/path" }},
		{"other scheme", func(r *Resend) { r.URL = "ftp://example.com/" }},
		{"bad header name", func(r *Resend) { r.Header = [][2]string{{"Bad Name", "x"}} }},
		{"header value with a newline", func(r *Resend) { r.Header = [][2]string{{"X", "a\r\nInjected: b"}} }},
		{"the proxy itself", func(r *Resend) { r.URL = "http://" + addr + "/" }},
		{"the proxy itself by Host", func(r *Resend) { r.Header = [][2]string{{"Host", addr}} }},
	}
	for _, tc := range cases {
		r := ok
		tc.edit(&r)
		_, err := p.Resend(r)
		if _, ok := errors.AsType[*InvalidRequestError](err); !ok {
			t.Errorf("%s: err = %v, want InvalidRequestError", tc.name, err)
		}
	}
	missing := ok
	missing.From = 999
	if _, err := p.Resend(missing); !errors.Is(err, ErrNoFlow) {
		t.Errorf("a missing flow: %v", err)
	}
	if n := len(store.Summaries()); n != 1 {
		t.Errorf("refused requests were recorded: %d flows", n)
	}
}

// 本文が記録の上限で切れていれば、本文を書き換えずには送れない（書き換えれば送れる）。
func TestResendNeedsTheWholeBody(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	req, _ := http.NewRequest("POST", up.URL+"/big", strings.NewReader(strings.Repeat("a", MaxBody+10)))
	orig := recordOne(t, c, store, req)

	r := Resend{From: orig.ID, Method: "POST", URL: up.URL + "/big"}
	if _, err := p.Resend(r); !errors.Is(err, ErrBodyCut) {
		t.Fatalf("resending a cut body: %v", err)
	}
	small := []byte("small")
	r.Body = &small
	if _, err := p.Resend(r); err != nil {
		t.Fatal(err)
	}
	waitDone(t, store, 2)
	if s := g.snapshot(); s.body != "small" {
		t.Errorf("upstream got %q", s.body)
	}
}

// 行き先につながらなければ、送り直した通信は failed になる。
func TestResendToAnUnreachableHostFails(t *testing.T) {
	var g got
	up := httptest.NewServer(http.HandlerFunc(g.handler))
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	req, _ := http.NewRequest("GET", up.URL+"/", nil)
	orig := recordOne(t, c, store, req)
	url := up.URL
	up.Close()

	if _, err := p.Resend(Resend{From: orig.ID, Method: "GET", URL: url + "/"}); err != nil {
		t.Fatal(err)
	}
	list := waitDone(t, store, 2)
	if f := list[1]; f.State != StateFailed || f.Error == "" {
		t.Errorf("the resent flow: %+v", f)
	}
}

func TestResendWithoutAStore(t *testing.T) {
	ca, err := LoadOrCreateCA(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := New(Options{CA: ca})
	defer p.Close()
	if _, err := p.Resend(Resend{From: 1, Method: "GET", URL: "http://example.com/"}); !errors.Is(err, ErrNoRecord) {
		t.Errorf("err = %v", err)
	}
}

// Host と違う所につないだ通信（curl --connect-to など）は、つないだ先を記録し、送り直すときも同じ所につなぐ。
func TestResendConnectsWhereTheOriginalConnected(t *testing.T) {
	var gotHost string
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		_, _ = io.WriteString(w, "from the target")
	}))
	up.StartTLS()
	defer up.Close()
	p, store, ca, addr := startProxy(t, upstreamPool(up))
	target := strings.TrimPrefix(up.URL, "https://")
	tr := &http.Transport{
		Proxy:           http.ProxyURL(&url.URL{Scheme: "http", Host: addr}),
		TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), ServerName: "example.com"},
	}
	defer tr.CloseIdleConnections()
	req, _ := http.NewRequest("GET", "https://"+target+"/pinned", nil)
	req.Host = "example.com"
	orig := recordOne(t, &http.Client{Transport: tr, Timeout: 10 * time.Second}, store, req)
	d, _ := store.Detail(orig.ID)
	if d.ConnectTo != target || d.Host != "example.com" {
		t.Fatalf("detail: connectTo %q host %q", d.ConnectTo, d.Host)
	}

	gotHost = ""
	if _, err := p.Resend(Resend{From: orig.ID, Method: "GET", URL: "https://example.com/pinned", ConnectTo: d.ConnectTo}); err != nil {
		t.Fatal(err)
	}
	list := waitDone(t, store, 2)
	r := list[1]
	if r.Status != 200 || r.State != StateDone || gotHost != "example.com" {
		t.Fatalf("the resent flow: %+v, upstream Host %q", r, gotHost)
	}
	if rd, _ := store.Detail(r.ID); rd.ConnectTo != target || rd.RespBody.Text == nil || *rd.RespBody.Text != "from the target" {
		t.Errorf("detail of the resent flow: %+v", rd)
	}

	for _, bad := range []string{"no-port", "127.0.0.1:", addr} {
		_, err := p.Resend(Resend{From: orig.ID, Method: "GET", URL: "https://example.com/", ConnectTo: bad})
		if _, ok := errors.AsType[*InvalidRequestError](err); !ok {
			t.Errorf("connectTo %q: %v", bad, err)
		}
	}
}

// 同時に送り直すのは MaxResending まで（超えたら ErrBusy）。プロキシを閉じると、受けている途中の応答も切る。
func TestResendLimitAndClose(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/endless" {
			// 終わらない応答（SSE など）：ヘッダーを送って、要求が切られるまで待つ
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer up.Close()
	p, store, ca, addr := startProxy(t, nil)
	c := clientVia(t, addr, ca.Pool())
	req, _ := http.NewRequest("GET", up.URL+"/", nil)
	orig := recordOne(t, c, store, req)

	endless := Resend{From: orig.ID, Method: "GET", URL: up.URL + "/endless"}
	for i := range MaxResending {
		if _, err := p.Resend(endless); err != nil {
			t.Fatalf("resend %d: %v", i+1, err)
		}
	}
	if _, err := p.Resend(endless); !errors.Is(err, ErrBusy) {
		t.Fatalf("resend over the limit: %v", err)
	}
	// 応答のヘッダーが届く（受けている途中になる）まで待ってから閉じる
	deadline := time.Now().Add(5 * time.Second)
	for {
		n := 0
		for _, f := range store.Summaries() {
			if f.Status == http.StatusOK {
				n++
			}
		}
		if n == MaxResending+1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("responses did not start: %+v", store.Summaries())
		}
		time.Sleep(10 * time.Millisecond)
	}
	p.Close()
	waitDone(t, store, MaxResending+1)
}
