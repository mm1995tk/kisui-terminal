package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/proxy"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// handoverProxyDirEnv は、引き継ぐ側の serve（handoverChild）に渡す、プロキシの認証局のフォルダ。
const handoverProxyDirEnv = "KISUI_SERVER_TEST_PROXY_DIR"

type proxyStarted struct {
	Scope       string          `json:"scope"`
	WorkspaceID string          `json:"workspaceId"`
	Port        int             `json:"port"`
	Recording   bool            `json:"recording"`
	Flows       []proxy.Summary `json:"flows"`
}

// startProxyServe は、プロキシの認証局をテストのフォルダに置く serve を動かす。roots は行き先を確かめる認証局。
func startProxyServe(t *testing.T, roots *x509.CertPool) (*Server, string, string) {
	t.Helper()
	t.Setenv("HOME", normalizePath(t.TempDir()))
	dir := t.TempDir()
	srv, sock := startFastWith(t, func(o *Options) { o.ProxyCADir, o.ProxyRootCAs = dir, roots })
	return srv, sock, dir
}

func proxyStart(t *testing.T, c *rpc.Conn, params map[string]any) proxyStarted {
	t.Helper()
	var r proxyStarted
	if err := c.Call(context.Background(), "proxy.start", params, &r); err != nil {
		t.Fatal(err)
	}
	if r.Port <= 0 {
		t.Fatalf("proxy.start: %+v", r)
	}
	return r
}

func proxyScopes(t *testing.T, c *rpc.Conn) []proxyScopeInfo {
	t.Helper()
	var r struct {
		Scopes []proxyScopeInfo `json:"scopes"`
	}
	if err := c.Call(context.Background(), "proxy.list", map[string]any{}, &r); err != nil {
		t.Fatal(err)
	}
	return r.Scopes
}

// viaProxy は、port のプロキシに通し、dir の認証局を信じるクライアント。
func viaProxy(t *testing.T, port int, dir string) *http.Client {
	t.Helper()
	ca, err := proxy.LoadOrCreateCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	tr := &http.Transport{
		// Go のクライアントは loopback の行き先をプロキシに通さないので、いつも通す
		Proxy:           func(*http.Request) (*url.URL, error) { return url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port)) },
		TLSClientConfig: &tls.Config{RootCAs: ca.Pool()},
	}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr, Timeout: 10 * time.Second}
}

func proxyUpstream(t *testing.T) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "hello from "+r.URL.Path)
	}))
	t.Cleanup(up.Close)
	pool := x509.NewCertPool()
	pool.AddCert(up.Certificate())
	return up, pool
}

func TestHelloAdvertisesProxy(t *testing.T) {
	_, sock := start(t)
	c := dial(t, sock)
	var r HelloResult
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), &r); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r.Capabilities, CapProxy) || !slices.Contains(r.Capabilities, CapProxyResend) {
		t.Fatalf("capabilities = %v", r.Capabilities)
	}
}

// 窓が決めた scope（内蔵ブラウザのタブ）を通すと、通信が一覧と知らせに出て、中身を読める。やめると待ち受け口が閉じる。
func TestProxyRecordsAScope(t *testing.T) {
	up, roots := proxyUpstream(t)
	_, sock, dir := startProxyServe(t, roots)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	st := proxyStart(t, c, map[string]any{"scope": "browser:tab1"})
	if st.Scope != "browser:tab1" || !st.Recording || len(st.Flows) != 0 {
		t.Fatalf("proxy.start: %+v", st)
	}
	resp, err := viaProxy(t, st.Port, dir).Get(up.URL + "/page")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "hello from /page" {
		t.Fatalf("body through the proxy: %q", body)
	}
	var flows struct {
		Flows []proxy.Summary `json:"flows"`
	}
	waitFor(t, "the flow to finish", func() bool {
		if err := c.Call(ctx, "proxy.flows", map[string]any{"scope": st.Scope}, &flows); err != nil {
			t.Fatal(err)
		}
		return len(flows.Flows) == 1 && flows.Flows[0].State == proxy.StateDone
	})
	f := flows.Flows[0]
	if f.Method != "GET" || f.Path != "/page" || f.Status != 200 || f.Scheme != "https" {
		t.Fatalf("flow: %+v", f)
	}
	// 知らせ（proxy.flow）にも同じ通信が出る
	waitFor(t, "proxy.flow", func() bool {
		nt.mu.Lock()
		defer nt.mu.Unlock()
		for _, m := range nt.got {
			var p struct {
				Scope string        `json:"scope"`
				Flow  proxy.Summary `json:"flow"`
			}
			if m.Method == "proxy.flow" && json.Unmarshal(m.Params, &p) == nil && p.Scope == st.Scope && p.Flow.ID == f.ID && p.Flow.State == proxy.StateDone {
				return true
			}
		}
		return false
	})
	var d proxy.Detail
	if err := c.Call(ctx, "proxy.detail", map[string]any{"scope": st.Scope, "id": f.ID}, &d); err != nil {
		t.Fatal(err)
	}
	if d.RespBody.Text == nil || *d.RespBody.Text != "hello from /page" || len(d.ReqHeaders) == 0 {
		t.Fatalf("detail: %+v", d)
	}
	if err := c.Call(ctx, "proxy.detail", map[string]any{"scope": st.Scope, "id": 999}, nil); !isCode(err, rpc.CodeNotFound) {
		t.Fatalf("detail of a missing flow: %v", err)
	}

	if err := c.Call(ctx, "proxy.stop", map[string]any{"scope": st.Scope}, nil); err != nil {
		t.Fatal(err)
	}
	if len(proxyScopes(t, c)) != 0 {
		t.Fatal("the scope is still listed after proxy.stop")
	}
	waitFor(t, "the port to close", func() bool {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", st.Port), time.Second)
		if err == nil {
			conn.Close()
		}
		return err != nil
	})
	if err := c.Call(ctx, "proxy.stop", map[string]any{"scope": st.Scope}, nil); !isCode(err, rpc.CodeNotFound) {
		t.Fatalf("stopping twice: %v", err)
	}
}

func TestProxyStartNeedsAScope(t *testing.T) {
	_, sock, _ := startProxyServe(t, nil)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	for _, p := range []map[string]any{{}, {"scope": "ws:w1"}, {"scope": "has space"}} {
		if err := c.Call(ctx, "proxy.start", p, nil); !isCode(err, rpc.CodeInvalidParams) {
			t.Errorf("proxy.start %v: %v", p, err)
		}
	}
	if err := c.Call(ctx, "proxy.start", map[string]any{"workspaceId": "w404"}, nil); !isCode(err, rpc.CodeNotFound) {
		t.Errorf("proxy.start for a missing workspace: %v", err)
	}
}

// ターミナルのタブ（ワークスペース）を通すと、そのあとに開いたペインにだけ、プロキシと認証局の環境変数が渡る。
// やめると、新しいペインには渡らず、待ち受け口は中継だけを続ける。ワークスペースを閉じると、待ち受け口も閉じる。
func TestProxyEnvForNewPanesOfAWorkspace(t *testing.T) {
	// このテストを動かす環境の変数が、ペインに引き継がれないように
	for _, k := range []string{"HTTPS_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"} {
		t.Setenv(k, "")
	}
	up, roots := proxyUpstream(t)
	_, sock, dir := startProxyServe(t, roots)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	wsID, primary := createWS(t, c)
	other, _ := createWS(t, c)
	st := proxyStart(t, c, map[string]any{"workspaceId": wsID})
	if st.Scope != "ws:"+wsID || st.WorkspaceID != wsID {
		t.Fatalf("proxy.start: %+v", st)
	}
	echo := func(term string) string {
		t.Helper()
		mark := fmt.Sprintf("P-%s=", term)
		c.Call(ctx, "term.input", map[string]any{"termId": term, "data": b64("printf 'P-%s=[%s][%s][%s]\\n' " + term + " \"$HTTPS_PROXY\" \"$SSL_CERT_FILE\" \"$NODE_EXTRA_CA_CERTS\"\n")}, nil)
		var line string
		waitFor(t, "env of "+term, func() bool {
			d, _ := nt.output(t, term)
			for l := range strings.SplitSeq(string(d), "\n") {
				if i := strings.Index(l, mark+"["); i >= 0 && strings.HasSuffix(strings.TrimRight(l, "\r"), "]") {
					line = strings.TrimRight(l[i+len(mark):], "\r")
					return true
				}
			}
			return false
		})
		return line
	}
	ca, err := proxy.LoadOrCreateCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("[http://127.0.0.1:%d][%s][%s]", st.Port, ca.BundlePath(), ca.CertPath())
	after := createTerm(t, c, map[string]any{"workspaceId": wsID})
	if got := echo(after); got != want {
		t.Errorf("a pane opened after proxy.start: %s, want %s", got, want)
	}
	// 先に開いていたペインと、ほかのワークスペースのペインには渡らない
	if got := echo(primary); got != "[][][]" {
		t.Errorf("the pane opened before proxy.start: %s", got)
	}
	if got := echo(createTerm(t, c, map[string]any{"workspaceId": other})); got != "[][][]" {
		t.Errorf("a pane of another workspace: %s", got)
	}

	if err := c.Call(ctx, "proxy.stop", map[string]any{"scope": st.Scope}, nil); err != nil {
		t.Fatal(err)
	}
	if got := echo(createTerm(t, c, map[string]any{"workspaceId": wsID})); got != "[][][]" {
		t.Errorf("a pane opened after proxy.stop: %s", got)
	}
	scopes := proxyScopes(t, c)
	if len(scopes) != 1 || scopes[0].Recording || scopes[0].Port != st.Port {
		t.Fatalf("scopes after proxy.stop: %+v", scopes)
	}
	// 環境変数を持ったままのペインのプログラムは、まだ通信できる（プロキシは中身を見ずに中継する）
	tr := &http.Transport{
		Proxy:           func(*http.Request) (*url.URL, error) { return url.Parse(fmt.Sprintf("http://127.0.0.1:%d", st.Port)) },
		TLSClientConfig: &tls.Config{RootCAs: roots},
	}
	defer tr.CloseIdleConnections()
	resp, err := (&http.Client{Transport: tr, Timeout: 10 * time.Second}).Get(up.URL + "/after-stop")
	if err != nil {
		t.Fatalf("through the stopped proxy: %v", err)
	}
	resp.Body.Close()
	var flows struct {
		Flows []proxy.Summary `json:"flows"`
	}
	if err := c.Call(ctx, "proxy.flows", map[string]any{"scope": st.Scope}, &flows); err != nil || len(flows.Flows) != 0 {
		t.Fatalf("flows recorded after proxy.stop: %v %+v", err, flows.Flows)
	}
	// 通し直すと、同じ待ち受け口で記録を続ける
	if again := proxyStart(t, c, map[string]any{"workspaceId": wsID}); again.Port != st.Port || !again.Recording {
		t.Fatalf("proxy.start again: %+v", again)
	}

	if err := c.Call(ctx, "workspace.close", map[string]any{"id": wsID, "force": true}, nil); err != nil {
		t.Fatal(err)
	}
	if scopes := proxyScopes(t, c); len(scopes) != 0 {
		t.Fatalf("scopes after workspace.close: %+v", scopes)
	}
}

// serve を引き継いでも、待ち受け口はそのまま使える（環境変数にポートを持つペインが通信できる）。
func TestHandoverKeepsProxyPorts(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", normalizePath(t.TempDir()))
	t.Setenv(handoverProxyDirEnv, dir)
	_, sock := startFastWith(t, func(o *Options) { o.ProxyCADir = dir })
	c, _ := termClient(t, sock)
	wsID, _ := createWS(t, c)
	st := proxyStart(t, c, map[string]any{"workspaceId": wsID})
	tab := proxyStart(t, c, map[string]any{"scope": "browser:t1"})
	if err := c.Call(context.Background(), "proxy.stop", map[string]any{"scope": st.Scope}, nil); err != nil {
		t.Fatal(err)
	}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "plain") }))
	defer up.Close()

	handOver(t, c, sock)
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the old serve did not close the GUI connection")
	}
	c2, _ := termClient(t, sock)
	scopes := proxyScopes(t, c2)
	if len(scopes) != 2 || scopes[0].Scope != "browser:t1" || scopes[0].Port != tab.Port || !scopes[0].Recording ||
		scopes[1].Scope != st.Scope || scopes[1].Port != st.Port || scopes[1].Recording || scopes[1].WorkspaceID != wsID {
		t.Fatalf("scopes after the handover: %+v", scopes)
	}
	// 古い serve が終わったあとも、同じポートで通る（古い serve が受けた接続は切れるので、通るまで試す）
	waitFor(t, "a request through the adopted proxy", func() bool {
		tr := &http.Transport{Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(fmt.Sprintf("http://127.0.0.1:%d", tab.Port)) }}
		defer tr.CloseIdleConnections()
		resp, err := (&http.Client{Transport: tr, Timeout: 2 * time.Second}).Get(up.URL)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b) == "plain"
	})
	var flows struct {
		Flows []proxy.Summary `json:"flows"`
	}
	waitFor(t, "the flow in the new serve", func() bool {
		if err := c2.Call(context.Background(), "proxy.flows", map[string]any{"scope": "browser:t1"}, &flows); err != nil {
			t.Fatal(err)
		}
		return len(flows.Flows) >= 1
	})
}

// proxy.resend：記録した通信の要求を書き換えて送ると、新しい通信として一覧に出て、応答を読める。
func TestProxyResend(t *testing.T) {
	up, roots := proxyUpstream(t)
	_, sock, dir := startProxyServe(t, roots)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	st := proxyStart(t, c, map[string]any{"scope": "browser:tab1"})
	resp, err := viaProxy(t, st.Port, dir).Get(up.URL + "/first")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	var flows struct {
		Flows []proxy.Summary `json:"flows"`
	}
	listFlows := func() []proxy.Summary {
		if err := c.Call(ctx, "proxy.flows", map[string]any{"scope": st.Scope}, &flows); err != nil {
			t.Fatal(err)
		}
		return flows.Flows
	}
	waitFor(t, "the first flow", func() bool {
		l := listFlows()
		return len(l) == 1 && l[0].State == proxy.StateDone
	})
	from := flows.Flows[0].ID

	var r struct {
		Flow proxy.Summary `json:"flow"`
	}
	params := map[string]any{"scope": st.Scope, "from": from, "method": "POST", "url": up.URL + "/second", "headers": [][2]string{{"X-A", "1"}}, "body": "edited"}
	if err := c.Call(ctx, "proxy.resend", params, &r); err != nil {
		t.Fatal(err)
	}
	if r.Flow.ResentFrom != from || r.Flow.Method != "POST" || r.Flow.Path != "/second" {
		t.Fatalf("proxy.resend: %+v", r.Flow)
	}
	waitFor(t, "the resent flow", func() bool {
		l := listFlows()
		return len(l) == 2 && l[1].State == proxy.StateDone
	})
	var d proxy.Detail
	if err := c.Call(ctx, "proxy.detail", map[string]any{"scope": st.Scope, "id": r.Flow.ID}, &d); err != nil {
		t.Fatal(err)
	}
	if d.RespBody.Text == nil || *d.RespBody.Text != "hello from /second" || d.ReqBody.Text == nil || *d.ReqBody.Text != "edited" {
		t.Fatalf("detail of the resent flow: %+v", d)
	}

	bad := []struct {
		params map[string]any
		code   int
	}{
		{map[string]any{"scope": "browser:none", "from": from, "method": "GET", "url": up.URL}, rpc.CodeNotFound},
		{map[string]any{"scope": st.Scope, "from": 999, "method": "GET", "url": up.URL}, rpc.CodeNotFound},
		{map[string]any{"scope": st.Scope, "from": from, "method": "GET", "url": "not a url"}, rpc.CodeInvalidParams},
	}
	for _, b := range bad {
		if err := c.Call(ctx, "proxy.resend", b.params, nil); !isCode(err, b.code) {
			t.Errorf("proxy.resend %v: %v", b.params, err)
		}
	}
}

// 止めるのを入れた scope の要求は、行き先に届く前に止まり（一覧に held で出る）、書き換えて流すと、書き換えた要求が届く。
// 窓がいなくなると、止めるのをやめて、止めていた要求をそのまま流す。
func TestProxyHoldAndRelease(t *testing.T) {
	up, roots := proxyUpstream(t)
	srv, sock, dir := startProxyServe(t, roots)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	var hr HelloResult
	if err := c.Call(ctx, "session.hello", hello(Protocol.Major), &hr); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(hr.Capabilities, CapProxyHold) {
		t.Fatalf("capabilities = %v", hr.Capabilities)
	}
	st := proxyStart(t, c, map[string]any{"scope": "browser:tab1"})
	var held struct {
		Holding bool `json:"holding"`
	}
	if err := c.Call(ctx, "proxy.hold", map[string]any{"scope": st.Scope, "on": true}, &held); err != nil || !held.Holding {
		t.Fatalf("proxy.hold: %+v %v", held, err)
	}
	if l := proxyScopes(t, c); len(l) != 1 || !l[0].Holding {
		t.Fatalf("proxy.list: %+v", l)
	}
	client := viaProxy(t, st.Port, dir)
	get := func(path string) <-chan string {
		ch := make(chan string, 1)
		go func() {
			resp, err := client.Get(up.URL + path)
			if err != nil {
				ch <- "error: " + err.Error()
				return
			}
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			ch <- fmt.Sprintf("%d %s", resp.StatusCode, b)
		}()
		return ch
	}
	var flows struct {
		Flows []proxy.Summary `json:"flows"`
	}
	waitHeld := func(n int) proxy.Summary {
		t.Helper()
		waitFor(t, "a held flow", func() bool {
			if err := c.Call(ctx, "proxy.flows", map[string]any{"scope": st.Scope}, &flows); err != nil {
				t.Fatal(err)
			}
			return len(flows.Flows) == n && flows.Flows[n-1].State == proxy.StateHeld
		})
		return flows.Flows[n-1]
	}
	answer := func(ch <-chan string) string {
		t.Helper()
		select {
		case a := <-ch:
			return a
		case <-time.After(5 * time.Second):
			t.Fatal("the client got no answer")
			return ""
		}
	}

	ch := get("/first")
	f := waitHeld(1)
	release := func(params map[string]any) error {
		params["scope"] = st.Scope
		return c.Call(ctx, "proxy.release", params, nil)
	}
	if err := release(map[string]any{"id": f.ID, "action": "edit", "method": "GET", "url": "not a url"}); !isCode(err, rpc.CodeInvalidParams) {
		t.Errorf("a bad edit: %v", err)
	}
	if err := release(map[string]any{"id": f.ID, "action": "bogus"}); !isCode(err, rpc.CodeInvalidParams) {
		t.Errorf("a bad action: %v", err)
	}
	if err := release(map[string]any{"id": 999, "action": "forward"}); !isCode(err, rpc.CodeNotFound) {
		t.Errorf("a flow that is not held: %v", err)
	}
	if err := release(map[string]any{"id": f.ID, "action": "edit", "method": "GET", "url": up.URL + "/edited", "headers": [][2]string{}}); err != nil {
		t.Fatal(err)
	}
	if a := answer(ch); a != "200 hello from /edited" {
		t.Errorf("the client got %q", a)
	}

	ch = get("/dropped")
	f = waitHeld(2)
	if err := release(map[string]any{"id": f.ID, "action": "drop"}); err != nil {
		t.Fatal(err)
	}
	if a := answer(ch); !strings.HasPrefix(a, "502 ") {
		t.Errorf("the client of a dropped request got %q", a)
	}

	// 窓がいなくなったら、止めていた要求はそのまま流れる
	ch = get("/left")
	waitHeld(3)
	c.Close()
	if a := answer(ch); a != "200 hello from /left" {
		t.Errorf("after the window left, the client got %q", a)
	}
	if sc := srv.proxy.get(st.Scope); sc == nil || sc.px.Holding() {
		t.Error("still holding after the window left")
	}
}
