// Package proxy は、通った HTTP・HTTPS の通信を記録するプロキシ（#409）。
//
// HTTP のプロキシとして待ち受ける。HTTPS（CONNECT）は、自前の認証局（CA）で行き先の証明書をその場で作って
// 間に入り、要求と応答を読む。行き先の証明書は、このプロキシが OS の認証局で確かめる（正しくなければ 502 を返す）。
// `kisui serve` が、通すと決めたタブごとに 1 つ動かし（server/proxy.go）、`kisui proxy` が単独で動かす。
// 行き先へは、直接つなぐ（このプロセスの HTTPS_PROXY などは見ない。自分自身に戻る輪を作らないため）。
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	dialTimeout      = 30 * time.Second
	handshakeTimeout = 15 * time.Second
	// peekWait は、CONNECT のあと、クライアントの最初の 1 バイト（TLS かどうか）を待つ時間。
	// 来なければ（サーバーが先に話すプロトコルなど）、中身を見ずにそのまま中継する。
	peekWait = 3 * time.Second
)

// Options は New に渡すもの。
type Options struct {
	CA *CA
	// Store は通信の記録先。nil なら記録しない。
	Store *Store
	// RootCAs は行き先の証明書を確かめる認証局。nil なら OS のもの（テストで差し替える）。
	RootCAs *x509.CertPool
}

// Proxy は 1 つの待ち受け口のプロキシ。
type Proxy struct {
	ca        *CA
	store     *Store
	transport *http.Transport
	// pinned は、Host と違う所につなぐ要求（exchange.dial）用。接続を使い回さない（Transport は接続を Host の
	// 名前で覚えるので、使い回すと、同じ Host で別の行き先の要求に、前の行き先の接続が使われる）
	pinned    *http.Transport
	relays    sync.Map // 中身を見ずに中継している接続（net.Conn）。Close で閉じる
	rp        *httputil.ReverseProxy
	outer     *http.Server
	inner     *http.Server
	conns     chan net.Conn // 間に入った TLS の接続を inner に渡す
	done      chan struct{}
	closeOnce sync.Once
	targets   sync.Map    // inner に渡した接続（net.Conn）→ tunnel
	intercept atomic.Bool // false の間は、間に入らず・記録もせずに中継だけする
	addr      atomic.Value
	// resending は送り直している（Resend）通信の数。closing は Close で終わる（送り直している通信を切る）
	resending   counter
	closing     context.Context
	stopClosing context.CancelFunc
}

type ctxKey int

const (
	targetKey ctxKey = iota
	exchangeKey
)

// tunnel は CONNECT の中の接続 1 本。target は CONNECT の行き先（host:port）、plain は TLS でなく HTTP がそのまま書かれているか。
type tunnel struct {
	target string
	plain  bool
}

// exchange は 1 往復の、行き先と記録。
type exchange struct {
	scheme, host string
	// dial は、host と違う所につなぐときの行き先（host:port）。CONNECT で頼まれた行き先と、中の要求の Host が
	// 違うとき（curl --connect-to など）。"" なら host につなぐ
	dial string
	flow *flow // 記録しないときは nil
}

// New はプロキシを作る。Serve で待ち受けを始める。
func New(o Options) *Proxy {
	p := &Proxy{ca: o.CA, store: o.Store, conns: make(chan net.Conn), done: make(chan struct{})}
	p.resending = newCounter(MaxResending)
	p.closing, p.stopClosing = context.WithCancel(context.Background())
	p.intercept.Store(true)
	dialer := &net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	p.pinned = &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if ex, _ := ctx.Value(exchangeKey).(*exchange); ex != nil && ex.dial != "" {
				addr = ex.dial
			}
			return dialer.DialContext(ctx, network, addr)
		},
		ForceAttemptHTTP2:   true,
		DisableCompression:  true,
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: handshakeTimeout,
		TLSClientConfig:     &tls.Config{RootCAs: o.RootCAs},
	}
	p.transport = &http.Transport{
		Proxy:               nil,
		DialContext:         dialer.DialContext,
		ForceAttemptHTTP2:   true,
		DisableCompression:  true, // 圧縮は自分で頼まず、クライアントの頼みをそのまま通す
		MaxIdleConns:        100,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: handshakeTimeout,
		TLSClientConfig:     &tls.Config{RootCAs: o.RootCAs},
	}
	quiet := log.New(io.Discard, "", 0)
	p.rp = &httputil.ReverseProxy{
		Rewrite:       p.rewrite,
		Transport:     recorder{p},
		FlushInterval: -1, // ストリーム（SSE など）を溜めずに流す
		ErrorHandler:  p.upstreamError,
		ErrorLog:      quiet,
	}
	p.outer = &http.Server{Handler: http.HandlerFunc(p.serveOuter), ReadHeaderTimeout: 30 * time.Second, ErrorLog: quiet}
	p.inner = &http.Server{
		Handler:           http.HandlerFunc(p.serveInner),
		ReadHeaderTimeout: 30 * time.Second,
		ErrorLog:          quiet,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if t, ok := p.targets.LoadAndDelete(c); ok {
				return context.WithValue(ctx, targetKey, t)
			}
			return ctx
		},
	}
	go func() { _ = p.inner.Serve(&chanListener{conns: p.conns, done: p.done}) }()
	return p
}

// Serve は ln で待ち受ける。Close されるまで戻らない。
func (p *Proxy) Serve(ln net.Listener) error {
	p.addr.Store(ln.Addr().String())
	err := p.outer.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Close は待ち受けをやめ、通している接続（中身を見ずに中継しているものも）を切る。
func (p *Proxy) Close() {
	p.closeOnce.Do(func() {
		close(p.done)
		p.stopClosing()
		_ = p.outer.Close()
		_ = p.inner.Close()
		p.transport.CloseIdleConnections()
		p.relays.Range(func(c, _ any) bool {
			_ = c.(net.Conn).Close()
			return true
		})
	})
}

// SetIntercept は、間に入って記録するかを切り替える。false の間は、HTTPS の中身を見ずに中継だけする
// （この待ち受け口を環境変数に持つプログラムが、記録をやめたあとも通信できるように）。
func (p *Proxy) SetIntercept(on bool) { p.intercept.Store(on) }

// Intercepting は、間に入って記録しているか。
func (p *Proxy) Intercepting() bool { return p.intercept.Load() }

// serveOuter は、クライアントがプロキシに送ってきた要求（CONNECT か、絶対 URL の http の要求）。
func (p *Proxy) serveOuter(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	if !r.URL.IsAbs() || r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "kisui proxy: this is an HTTP proxy; set it as the proxy of your program (HTTPS_PROXY, HTTP_PROXY)", http.StatusBadRequest)
		return
	}
	p.forward(w, r, "http", r.URL.Host, "")
}

// serveInner は、CONNECT の中の要求（間に入った TLS の中か、CONNECT の中にそのまま書かれた HTTP）。
func (p *Proxy) serveInner(w http.ResponseWriter, r *http.Request) {
	t, _ := r.Context().Value(targetKey).(tunnel)
	scheme := "https"
	if t.plain {
		scheme = "http"
	}
	host := r.Host
	if host == "" {
		host = t.target
	}
	if host == "" {
		http.Error(w, "kisui proxy: no host", http.StatusBadRequest)
		return
	}
	// つなぐ先は、CONNECT で頼まれた行き先。Host が別の名前でも、そこへは行かない（Host はそのまま送り、
	// 証明書はその名前で確かめる。プロキシ無しでクライアントがするのと同じ）
	dial := ""
	if t.target != "" && !sameAuthority(host, t.target, scheme) {
		dial = t.target
	}
	p.forward(w, r, scheme, host, dial)
}

// sameAuthority は、Host ヘッダーの値 host（ポートは省ける）と、行き先 target（host:port）が同じ所か。
func sameAuthority(host, target, scheme string) bool {
	return strings.EqualFold(withPortOf(host, scheme), target)
}

// forward は要求を行き先に送り、応答を返す。記録していれば Flow を足す。dial は、host と違う所につなぐときの行き先。
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, scheme, host, dial string) {
	if p.isSelf(host) || (dial != "" && p.isSelf(dial)) {
		http.Error(w, "kisui proxy: the request points at this proxy itself", http.StatusBadRequest)
		return
	}
	ex := &exchange{scheme: scheme, host: host, dial: dial}
	if p.store != nil && p.intercept.Load() {
		ex.flow = p.store.begin(r, scheme, host, dial)
	}
	p.rp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), exchangeKey, ex)))
}

// isSelf は host（host:port）が、このプロキシの待ち受け口か。
func (p *Proxy) isSelf(host string) bool {
	self, _ := p.addr.Load().(string)
	if self == "" {
		return false
	}
	h, port, err := net.SplitHostPort(host)
	_, selfPort, err2 := net.SplitHostPort(self)
	if err != nil || err2 != nil || port != selfPort {
		return false
	}
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// forwardedHeaders は、ReverseProxy が Rewrite の前に消すヘッダー。クライアントが付けたものは、そのまま通す。
var forwardedHeaders = []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"}

func (p *Proxy) rewrite(pr *httputil.ProxyRequest) {
	ex := pr.In.Context().Value(exchangeKey).(*exchange)
	pr.Out.URL.Scheme = ex.scheme
	pr.Out.URL.Host = ex.host
	pr.Out.Host = pr.In.Host
	// ReverseProxy は Rewrite の前に、解釈できないクエリ（`;` を含む・`%` の書き方が違う）を消して並べ直す。
	// クライアントが送ったままのクエリを送る
	pr.Out.URL.RawQuery = pr.In.URL.RawQuery
	for _, h := range forwardedHeaders {
		if v, ok := pr.In.Header[h]; ok {
			pr.Out.Header[h] = v
		}
	}
	// 本文を見せられるよう、展開できる圧縮（gzip）だけを行き先に頼む（br・zstd は標準ライブラリで展開できない）。
	// 応答は書き換えずにクライアントに返す（クライアントが gzip を頼んでいなければ、圧縮なしを頼む）
	if ex.flow != nil {
		if ae := pr.Out.Header.Get("Accept-Encoding"); ae != "" {
			pr.Out.Header.Set("Accept-Encoding", narrowEncoding(ae))
		}
	}
}

// narrowEncoding は Accept-Encoding の値を、gzip（頼まれていれば）か identity だけにする。
func narrowEncoding(ae string) string {
	for part := range strings.SplitSeq(ae, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		if q := strings.ReplaceAll(strings.ToLower(params), " ", ""); q == "q=0" || q == "q=0.0" || q == "q=0.00" || q == "q=0.000" {
			continue
		}
		return "gzip"
	}
	return "identity"
}

func (p *Proxy) upstreamError(w http.ResponseWriter, r *http.Request, err error) {
	ex, _ := r.Context().Value(exchangeKey).(*exchange)
	host := ""
	if ex != nil {
		host = ex.host
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusBadGateway)
	fmt.Fprintf(w, "kisui proxy: cannot reach %s: %v\n", host, err)
}

// recorder は行き先との 1 往復を送り、記録していれば Flow に書く。
type recorder struct{ p *Proxy }

func (rec recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	p := rec.p
	ex, _ := req.Context().Value(exchangeKey).(*exchange)
	var tr http.RoundTripper = p.transport
	if ex != nil && ex.dial != "" {
		tr = p.pinned
	}
	if ex == nil || ex.flow == nil {
		return tr.RoundTrip(req)
	}
	f := ex.flow
	if req.Body != nil && req.Body != http.NoBody {
		r2 := *req
		r2.Body = &capture{rc: req.Body, done: func(b Body, _ error) {
			p.store.update(f, func(f *flow) { f.reqBody = b })
		}}
		req = &r2
	}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		p.store.update(f, func(f *flow) {
			f.state, f.err, f.duration = StateFailed, err.Error(), time.Since(f.start)
		})
		return nil, err
	}
	header := resp.Header.Clone()
	// プロトコルの切り替え（WebSocket など）は、切り替えたあとの中身を記録しない
	if resp.StatusCode == http.StatusSwitchingProtocols || resp.Body == nil || resp.Body == http.NoBody {
		p.store.update(f, func(f *flow) {
			f.status, f.respHeader, f.state, f.duration = resp.StatusCode, header, StateDone, time.Since(f.start)
		})
		return resp, nil
	}
	p.store.update(f, func(f *flow) { f.status, f.respHeader = resp.StatusCode, header })
	resp.Body = &capture{rc: resp.Body, done: func(b Body, err error) {
		p.store.update(f, func(f *flow) {
			f.respBody, f.duration, f.state = b, time.Since(f.start), StateDone
			if err != nil && !errors.Is(err, context.Canceled) {
				f.state, f.err = StateFailed, err.Error()
			}
		})
	}}
	return resp, nil
}

// connect は CONNECT。行き先を確かめ、中身の種類で振り分ける：TLS なら間に入り、HTTP ならそのまま読み、
// どちらでもなければ（間に入らない設定のときも）中身を見ずに中継する。
func (p *Proxy) connect(w http.ResponseWriter, r *http.Request) {
	target := r.Host
	if _, _, err := net.SplitHostPort(target); err != nil {
		http.Error(w, "kisui proxy: CONNECT needs host:port", http.StatusBadRequest)
		return
	}
	if p.isSelf(target) {
		http.Error(w, "kisui proxy: the request points at this proxy itself", http.StatusBadRequest)
		return
	}
	if !p.intercept.Load() {
		p.relayOnly(w, target)
		return
	}
	client := accept(w, nil)
	if client == nil {
		return
	}
	switch sniff(client) {
	case kindTLS:
		p.interceptTLS(client, target)
	case kindHTTP:
		// CONNECT の中に、そのまま HTTP を書くクライアント（macOS の WebView は、http:// も CONNECT で送る）
		p.serveTunnel(client, tunnel{target: target, plain: true})
	case kindOther:
		if up, err := net.DialTimeout("tcp", target, dialTimeout); err == nil {
			p.relay(client, up)
		} else {
			client.Close()
		}
	case kindGone:
		client.Close()
	}
}

// accept は CONNECT に「つながった」と答えて、クライアントの接続を受け取る。受け取れなければ nil
// （up があれば閉じる）。
func accept(w http.ResponseWriter, up net.Conn) *bufConn {
	fail := func() *bufConn {
		if up != nil {
			up.Close()
		}
		return nil
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "kisui proxy: cannot take over the connection", http.StatusInternalServerError)
		return fail()
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return fail()
	}
	if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		conn.Close()
		return fail()
	}
	return &bufConn{Conn: conn, r: brw.Reader}
}

// relayOnly は、間に入らない設定のときの CONNECT。行き先につないでから答える（つながらなければ 502 を返せる）。
func (p *Proxy) relayOnly(w http.ResponseWriter, target string) {
	up, err := net.DialTimeout("tcp", target, dialTimeout)
	if err != nil {
		http.Error(w, "kisui proxy: cannot reach "+target+": "+err.Error(), http.StatusBadGateway)
		return
	}
	if client := accept(w, up); client != nil {
		p.relay(client, up)
	}
}

// CONNECT の中身の種類。
type tunnelKind int

const (
	kindTLS   tunnelKind = iota // TLS の handshake で始まる
	kindHTTP                    // HTTP の要求がそのまま書かれている
	kindOther                   // どちらでもない・クライアントが先に話さない（サーバーが先に話すプロトコルなど）
	kindGone                    // クライアントが切った
)

// httpMethods は、CONNECT の中の最初の字が HTTP の要求かを見分けるための、メソッドの名前（後ろに空白）。
var httpMethods = [][]byte{[]byte("GET "), []byte("HEAD "), []byte("POST "), []byte("PUT "), []byte("PATCH "), []byte("DELETE "), []byte("OPTIONS ")}

// sniff は、クライアントが最初に送ってきたバイトを、読み進めずに見て、中身の種類を返す（peekWait まで待つ）。
// SSH のように、HTTP と同じく英字で始まる別のプロトコルは kindOther。
func sniff(c *bufConn) tunnelKind {
	peek := func(n int) ([]byte, error) {
		_ = c.Conn.SetReadDeadline(time.Now().Add(peekWait))
		defer func() { _ = c.Conn.SetReadDeadline(time.Time{}) }()
		return c.r.Peek(n)
	}
	first, err := peek(1)
	switch {
	case err != nil && isTimeout(err):
		return kindOther
	case err != nil:
		return kindGone
	case first[0] == 0x16: // TLS の handshake
		return kindTLS
	}
	head, _ := peek(8)
	for _, m := range httpMethods {
		if bytes.HasPrefix(head, m) {
			return kindHTTP
		}
	}
	return kindOther
}

// interceptTLS は、クライアントの TLS の間に入る：クライアントが言った名前（SNI。無ければ CONNECT の行き先）の
// 証明書を作って handshake し、中の要求を読むサーバーに渡す。
func (p *Proxy) interceptTLS(client net.Conn, target string) {
	hostOnly, _, _ := net.SplitHostPort(target)
	tc := tls.Server(client, &tls.Config{
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			name := h.ServerName
			if name == "" {
				name = hostOnly
			}
			return p.ca.leaf(name)
		},
		NextProtos: []string{"h2", "http/1.1"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	defer cancel()
	if err := tc.HandshakeContext(ctx); err != nil {
		// クライアントが認証局を信じていないと、ここで切られる
		tc.Close()
		return
	}
	p.serveTunnel(tc, tunnel{target: target})
}

// serveTunnel は、CONNECT の中の接続 c を、中の要求を読むサーバー（inner）に渡す。
func (p *Proxy) serveTunnel(c net.Conn, t tunnel) {
	p.targets.Store(c, t)
	select {
	case p.conns <- c:
	case <-p.done:
		p.targets.Delete(c)
		c.Close()
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// relay は 2 つの接続の間を、どちらかが閉じる・プロキシが Close されるまで運ぶ。
func (p *Proxy) relay(a, b net.Conn) {
	p.relays.Store(a, nil)
	p.relays.Store(b, nil)
	defer p.relays.Delete(a)
	defer p.relays.Delete(b)
	select {
	case <-p.done: // 覚える前に Close されていた
		a.Close()
		b.Close()
		return
	default:
	}
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		// 片方が送り終えたら、相手に送り終わりを伝える（半分だけ閉じる）
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}

// bufConn は、先読みしたバイトを持つ接続。
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// CloseWrite は送り終わりを伝える（TCP のとき）。
func (c *bufConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return c.Conn.Close()
}

// chanListener は、チャネルで受けた接続を Accept で返す。
type chanListener struct {
	conns <-chan net.Conn
	done  <-chan struct{}
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *chanListener) Close() error   { return nil }
func (l *chanListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)} }

// Env は、addr（host:port）のプロキシに通し、認証局を信じさせる環境変数（"NAME=value"）。
// プロキシの変数は大文字と小文字の両方（プログラムによって読む方が違う）。認証局の変数は、束を丸ごと置き換えるもの
// （SSL_CERT_FILE など）には OS の束に足したファイルを、足すもの（NODE_EXTRA_CA_CERTS）には証明書だけのファイルを渡す。
func Env(addr string, ca *CA) []string {
	url := "http://" + addr
	bundle, cert := ca.BundlePath(), ca.CertPath()
	return []string{
		"HTTPS_PROXY=" + url,
		"HTTP_PROXY=" + url,
		"https_proxy=" + url,
		"http_proxy=" + url,
		"SSL_CERT_FILE=" + bundle,
		"NIX_SSL_CERT_FILE=" + bundle,
		"CURL_CA_BUNDLE=" + bundle,
		"REQUESTS_CA_BUNDLE=" + bundle,
		"GIT_SSL_CAINFO=" + bundle,
		"AWS_CA_BUNDLE=" + bundle,
		"CARGO_HTTP_CAINFO=" + bundle,
		"NODE_EXTRA_CA_CERTS=" + cert,
		"DENO_CERT=" + cert,
	}
}
