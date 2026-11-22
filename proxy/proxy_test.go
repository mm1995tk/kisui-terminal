package proxy

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// startProxy は、テスト用の認証局とプロキシを動かす。upstream は行き先の証明書を確かめる認証局（nil なら OS のもの）。
func startProxy(t *testing.T, upstream *x509.CertPool) (*Proxy, *Store, *CA, string) {
	t.Helper()
	ca, err := LoadOrCreateCA(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(nil)
	p := New(Options{CA: ca, Store: store, RootCAs: upstream})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = p.Serve(ln) }()
	t.Cleanup(p.Close)
	return p, store, ca, ln.Addr().String()
}

// clientVia は、addr のプロキシに通し、roots の認証局を信じるクライアント。
func clientVia(t *testing.T, addr string, roots *x509.CertPool) *http.Client {
	t.Helper()
	tr := &http.Transport{
		Proxy:              http.ProxyURL(&url.URL{Scheme: "http", Host: addr}),
		TLSClientConfig:    &tls.Config{RootCAs: roots},
		ForceAttemptHTTP2:  true,
		DisableCompression: true,
	}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr, Timeout: 10 * time.Second}
}

func gz(s string) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	return b.Bytes()
}

// waitDone は、通信が 1 つ終わるまで待って、その一覧を返す。
func waitDone(t *testing.T, s *Store, n int) []Summary {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		list := s.Summaries()
		done := 0
		for _, f := range list {
			if f.State != StatePending {
				done++
			}
		}
		if done >= n {
			return list
		}
		if time.Now().After(deadline) {
			t.Fatalf("flows did not finish: %+v", list)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func upstreamPool(srv *httptest.Server) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(srv.Certificate())
	return p
}

func TestRecordsHTTPSThroughTheProxy(t *testing.T) {
	var gotAE, gotFwd string
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAE, gotFwd = r.Header.Get("Accept-Encoding"), r.Header.Get("X-Forwarded-For")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(gz(`{"hello":"世界"}`))
	}))
	up.EnableHTTP2 = true
	up.StartTLS()
	defer up.Close()
	_, store, ca, addr := startProxy(t, upstreamPool(up))
	c := clientVia(t, addr, ca.Pool())

	req, _ := http.NewRequest("GET", up.URL+"/api/items?x=1", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.ProtoMajor != 2 {
		t.Errorf("the client spoke HTTP/%d to the proxy, want 2", resp.ProtoMajor)
	}
	// 応答は書き換えずに返す（gzip のまま）
	if resp.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(body, gz(`{"hello":"世界"}`)) {
		t.Errorf("the response was changed: encoding %q, %d bytes", resp.Header.Get("Content-Encoding"), len(body))
	}
	if gotAE != "gzip" {
		t.Errorf("Accept-Encoding sent upstream = %q, want gzip", gotAE)
	}
	if gotFwd != "203.0.113.9" {
		t.Errorf("X-Forwarded-For sent upstream = %q, want the client's", gotFwd)
	}

	list := waitDone(t, store, 1)
	if len(list) != 1 {
		t.Fatalf("flows = %+v, want 1", list)
	}
	f := list[0]
	host := strings.TrimPrefix(up.URL, "https://")
	if f.Method != "GET" || f.Scheme != "https" || f.Host != host || f.Path != "/api/items?x=1" || f.Status != 200 || f.State != StateDone || f.MIME != "application/json" {
		t.Errorf("summary = %+v", f)
	}
	d, ok := store.Detail(f.ID)
	if !ok {
		t.Fatal("no detail")
	}
	if d.RespBody.Text == nil || *d.RespBody.Text != `{"hello":"世界"}` {
		t.Errorf("response body = %+v, want the decoded text", d.RespBody)
	}
	// 記録には、クライアントが送ったままのヘッダーを残す
	if !hasHeader(d.ReqHeaders, "Accept-Encoding", "gzip, deflate, br, zstd") {
		t.Errorf("request headers = %v", d.ReqHeaders)
	}
}

func hasHeader(list [][2]string, name, value string) bool {
	for _, h := range list {
		if h[0] == name && h[1] == value {
			return true
		}
	}
	return false
}

func TestRecordsPlainHTTPWithABody(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(append([]byte("got "), b...))
	}))
	defer up.Close()
	_, store, _, addr := startProxy(t, nil)
	// httptest のサーバーは 127.0.0.1 で待つ。Go のクライアントは loopback をプロキシに通さないので、プロキシに直接送る
	req, _ := http.NewRequest("POST", up.URL+"/submit", strings.NewReader("name=kisui"))
	tr := &http.Transport{Proxy: func(*http.Request) (*url.URL, error) { return &url.URL{Scheme: "http", Host: addr}, nil }}
	defer tr.CloseIdleConnections()
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 201 || string(body) != "got name=kisui" {
		t.Fatalf("response = %d %q", resp.StatusCode, body)
	}
	list := waitDone(t, store, 1)
	d, _ := store.Detail(list[0].ID)
	if d.Scheme != "http" || d.Status != 201 || d.ReqBody.Text == nil || *d.ReqBody.Text != "name=kisui" || *d.RespBody.Text != "got name=kisui" {
		t.Errorf("detail = %+v", d)
	}
	if d.ReqSize != 10 || d.RespSize != 14 {
		t.Errorf("sizes = %d, %d", d.ReqSize, d.RespSize)
	}
}

func TestRelaysWithoutRecordingWhenNotIntercepting(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "direct")
	}))
	defer up.Close()
	p, store, _, addr := startProxy(t, nil)
	p.SetIntercept(false)
	// 間に入らないので、クライアントは行き先の証明書そのものを見る（プロキシの認証局は要らない）
	c := clientVia(t, addr, upstreamPool(up))
	resp, err := c.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "direct" {
		t.Errorf("body = %q", body)
	}
	if n := len(store.Summaries()); n != 0 {
		t.Errorf("recorded %d flows while not intercepting", n)
	}
}

func TestRefusesAnUntrustedUpstream(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "secret")
	}))
	defer up.Close()
	// 行き先の証明書（httptest の自己署名）を、プロキシは信じない
	_, store, ca, addr := startProxy(t, x509.NewCertPool())
	c := clientVia(t, addr, ca.Pool())
	resp, err := c.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || strings.Contains(string(body), "secret") {
		t.Errorf("response = %d %q, want 502 without the page", resp.StatusCode, body)
	}
	list := waitDone(t, store, 1)
	if list[0].State != StateFailed || list[0].Error == "" {
		t.Errorf("flow = %+v, want failed with the reason", list[0])
	}
}

func TestClientWithoutTheCAIsNotServed(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer up.Close()
	_, _, _, addr := startProxy(t, upstreamPool(up))
	c := clientVia(t, addr, x509.NewCertPool())
	if resp, err := c.Get(up.URL); err == nil {
		resp.Body.Close()
		t.Fatal("a client that does not trust the CA got a response")
	}
}

func TestCAIsCreatedOnceAndPrivate(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreateCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, caKeyFile))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v, mode %v, want 0600", err, fi.Mode().Perm())
	}
	b, err := LoadOrCreateCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.CertPEM(), b.CertPEM()) {
		t.Error("the second load made another CA")
	}
	if !a.cert.IsCA || !a.cert.MaxPathLenZero {
		t.Errorf("CA constraints: IsCA=%v MaxPathLenZero=%v", a.cert.IsCA, a.cert.MaxPathLenZero)
	}
	bundle, err := os.ReadFile(a.BundlePath())
	if err != nil || !bytes.HasSuffix(bundle, a.CertPEM()) {
		t.Errorf("the bundle does not end with the CA: %v", err)
	}
	cert, _ := os.ReadFile(a.CertPath())
	if !bytes.Equal(cert, a.CertPEM()) || bytes.Contains(cert, []byte("PRIVATE KEY")) {
		t.Error("the certificate file is not the certificate alone")
	}
	// 秘密鍵がほかの人に読める権限なら、使わない
	if err := os.Chmod(filepath.Join(dir, caKeyFile), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateCA(dir); err == nil {
		t.Error("a key readable by others was accepted")
	}
}

func TestLeafIsForTheNameAndReused(t *testing.T) {
	ca, err := LoadOrCreateCA(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	l, err := ca.leaf("example.com")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Leaf.Verify(x509.VerifyOptions{Roots: ca.Pool(), DNSName: "example.com"}); err != nil {
		t.Errorf("leaf does not verify: %v", err)
	}
	if l2, _ := ca.leaf("example.com"); l2 != l {
		t.Error("the leaf was made again")
	}
	ip, err := ca.leaf("127.0.0.1")
	if err != nil || len(ip.Leaf.IPAddresses) != 1 {
		t.Errorf("leaf for an IP address: %v %v", err, ip)
	}
}

func TestStoreDropsTheOldest(t *testing.T) {
	var seen []int64
	s := NewStore(func(sum Summary) { seen = append(seen, sum.ID) })
	r := httptest.NewRequest("GET", "http://example.com/a", nil)
	for range MaxFlows + 5 {
		s.begin(r, "http", "example.com")
	}
	list := s.Summaries()
	if len(list) != MaxFlows || list[0].ID != 6 || list[len(list)-1].ID != MaxFlows+5 {
		t.Errorf("kept %d flows, %d..%d", len(list), list[0].ID, list[len(list)-1].ID)
	}
	if len(seen) != MaxFlows+5 {
		t.Errorf("onChange was called %d times", len(seen))
	}
	if _, ok := s.Detail(1); ok {
		t.Error("a dropped flow still has its detail")
	}
}

func TestStoreDropsByTotalBodySize(t *testing.T) {
	s := NewStore(nil)
	r := httptest.NewRequest("GET", "http://example.com/a", nil)
	big := make([]byte, MaxBody)
	n := MaxStoreBytes/MaxBody + 3
	for range n {
		f := s.begin(r, "http", "example.com")
		s.update(f, func(f *flow) { f.respBody = Body{Data: big, Size: int64(len(big))} })
	}
	if got := len(s.Summaries()); got != MaxStoreBytes/MaxBody {
		t.Errorf("kept %d flows, want %d", got, MaxStoreBytes/MaxBody)
	}
}

func TestViewBody(t *testing.T) {
	h := func(enc string) http.Header { return http.Header{"Content-Encoding": {enc}} }
	if v := viewBody(Body{Data: []byte{0xff, 0x00, 0x01}, Size: 3}, http.Header{}); !v.Binary || v.Text != nil {
		t.Errorf("binary body = %+v", v)
	}
	if v := viewBody(Body{Data: []byte("x"), Size: 1}, h("br")); !v.Binary || v.Encoding != "br" {
		t.Errorf("br body = %+v", v)
	}
	// 途中で切れた gzip は、読めた所まで見せる
	var lines strings.Builder
	for i := range 20000 {
		fmt.Fprintf(&lines, "kisui line %d\n", i*7919)
	}
	full := gz(lines.String())
	if v := viewBody(Body{Data: full[:len(full)/2], Size: int64(len(full)), Truncated: true}, h("gzip")); v.Text == nil || !strings.HasPrefix(*v.Text, "kisui line 0\nkisui line 7919\n") || !v.Truncated {
		t.Errorf("cut gzip body = %+v", v)
	}
	// 切れた本文の最後の字が途中でも、字として見せる
	if v := viewBody(Body{Data: []byte("あい")[:5], Size: 6, Truncated: true}, http.Header{}); v.Text == nil || *v.Text != "あ" {
		t.Errorf("cut text = %+v", v)
	}
}

func TestNarrowEncoding(t *testing.T) {
	for in, want := range map[string]string{
		"gzip, deflate, br":    "gzip",
		"br;q=1.0, GZIP;q=0.8": "gzip",
		"br, zstd":             "identity",
		"gzip;q=0, br":         "identity",
		"identity":             "identity",
	} {
		if got := narrowEncoding(in); got != want {
			t.Errorf("narrowEncoding(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEnvPointsAtTheProxyAndTheCA(t *testing.T) {
	ca, err := LoadOrCreateCA(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env := strings.Join(Env("127.0.0.1:4321", ca), "\n")
	for _, want := range []string{
		"HTTPS_PROXY=http://127.0.0.1:4321", "http_proxy=http://127.0.0.1:4321",
		"SSL_CERT_FILE=" + ca.BundlePath(), "NODE_EXTRA_CA_CERTS=" + ca.CertPath(), "REQUESTS_CA_BUNDLE=" + ca.BundlePath(),
	} {
		if !strings.Contains(env, want) {
			t.Errorf("env lacks %s", want)
		}
	}
}

// CONNECT の中に HTTP をそのまま書くクライアント（macOS の WebView の http://）も記録する。HTTP でないものは中継だけする。
func TestConnectWithPlainHTTPInside(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "plain inside")
	}))
	defer up.Close()
	_, store, _, addr := startProxy(t, nil)
	host := strings.TrimPrefix(up.URL, "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", host, host)
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %v %v", resp, err)
	}
	fmt.Fprintf(conn, "GET /inside HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	resp, err = http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "plain inside" {
		t.Fatalf("body = %q", body)
	}
	list := waitDone(t, store, 1)
	if list[0].Scheme != "http" || list[0].Host != host || list[0].Path != "/inside" || list[0].Status != 200 {
		t.Errorf("flow = %+v", list[0])
	}
}

func TestConnectWithAnotherProtocolIsOnlyRelayed(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 8)
		if _, err := io.ReadFull(c, buf); err == nil {
			_, _ = c.Write(append([]byte("echo:"), buf...))
		}
	}()
	_, store, _, addr := startProxy(t, nil)
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", ln.Addr(), ln.Addr())
	br := bufio.NewReader(conn)
	if resp, err := http.ReadResponse(br, nil); err != nil || resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %v %v", resp, err)
	}
	_, _ = conn.Write([]byte("SSH-2.0-"))
	got := make([]byte, 13)
	if _, err := io.ReadFull(br, got); err != nil || string(got) != "echo:SSH-2.0-" {
		t.Fatalf("relayed: %q %v", got, err)
	}
	if n := len(store.Summaries()); n != 0 {
		t.Errorf("recorded %d flows for a protocol that is not HTTP", n)
	}
}

// クエリは、解釈できない形（`;`・正しくない `%`）でも、クライアントが送ったまま行き先に届く。
func TestQueryReachesTheUpstreamAsSent(t *testing.T) {
	var got string
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
	}))
	defer up.Close()
	_, store, ca, addr := startProxy(t, upstreamPool(up))
	c := clientVia(t, addr, ca.Pool())
	for i, q := range []string{"b=2&a=1", "b=2;a=1", "z=1&q=100%&a=2", "z=1&a=%zz"} {
		req, _ := http.NewRequest("GET", up.URL+"/x", nil)
		req.URL.RawQuery = q
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got != q {
			t.Errorf("query %q reached the upstream as %q", q, got)
		}
		if list := waitDone(t, store, i+1); list[i].Path != "/x?"+q {
			t.Errorf("recorded path = %q, want %q", list[i].Path, "/x?"+q)
		}
	}
}

// CONNECT の中の HTTPS の要求は、Host が別の名前でも、CONNECT で頼まれた行き先につなぐ（curl --connect-to の形）。
// Host はそのまま行き先に届く。
func TestConnectTargetWinsOverTheHostHeader(t *testing.T) {
	var gotHost string
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		_, _ = io.WriteString(w, "from the target")
	}))
	up.StartTLS()
	defer up.Close()
	// 行き先の証明書（httptest。example.com 用でもある）を信じる
	_, store, ca, addr := startProxy(t, upstreamPool(up))
	target := strings.TrimPrefix(up.URL, "https://")
	tr := &http.Transport{
		Proxy:           http.ProxyURL(&url.URL{Scheme: "http", Host: addr}),
		TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), ServerName: "example.com"},
	}
	defer tr.CloseIdleConnections()
	req, _ := http.NewRequest("GET", "https://"+target+"/pinned", nil)
	req.Host = "example.com"
	resp, err := (&http.Client{Transport: tr, Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "from the target" || gotHost != "example.com" {
		t.Fatalf("response = %d %q, upstream Host = %q", resp.StatusCode, body, gotHost)
	}
	if list := waitDone(t, store, 1); list[0].Host != "example.com" || list[0].Path != "/pinned" {
		t.Errorf("flow = %+v", list[0])
	}
}

// Close は、中身を見ずに中継している接続も切る。
func TestCloseEndsRelayedConnections(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c) }()
		}
	}()
	p, _, _, addr := startProxy(t, nil)
	p.SetIntercept(false)
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", ln.Addr(), ln.Addr())
	br := bufio.NewReader(conn)
	if resp, err := http.ReadResponse(br, nil); err != nil || resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %v %v", resp, err)
	}
	_, _ = conn.Write([]byte("ping"))
	got := make([]byte, 4)
	if _, err := io.ReadFull(br, got); err != nil || string(got) != "ping" {
		t.Fatalf("relayed: %q %v", got, err)
	}
	p.Close()
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("the relayed connection is still open after Close")
	}
}
