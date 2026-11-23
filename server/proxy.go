package server

// プロキシ（proxy.*。#409）。窓が選んだタブの HTTP・HTTPS の通信を、このマシンで動かすプロキシ（proxy パッケージ）に通して
// 記録する。取り決めは docs/design/gui-protocol.md の「プロキシ」。
//
// 通す単位（scope）ごとに、待ち受け口（127.0.0.1 の空いているポート）と記録を 1 つずつ持つ。
//   - ターミナルのタブ（このサーバーのワークスペース）：scope は "ws:<ワークスペースの id>"。通している間に開いたペインに、
//     プロキシと認証局の環境変数を渡す（term.go の start）。動いているシェルの環境変数は変えられないので、
//     先に開いていたペインは通らない。
//   - 内蔵ブラウザのタブ：scope は窓が決めた名前。窓が、その待ち受け口をプロキシにした webview を作る。
//
// ワークスペースの scope は、通すのをやめても待ち受け口を閉じない（中身を見ず・記録もせずに中継だけする）。
// 環境変数を渡したペインのプログラムが、やめたあとも通信できるように。閉じるのは、ワークスペースを閉じたとき。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/mm1995tk/kisui-terminal/proxy"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapProxy は session.hello の capabilities に入れる、proxy.* を受けられる印。
const CapProxy = "proxy"

// CapProxyResend は capabilities に入れる、proxy.resend（記録した通信の要求を書き換えて送り直す。#410）を受けられる印。
const CapProxyResend = "proxy.resend"

// CapProxyHold は capabilities に入れる、proxy.hold・proxy.release（要求を行き先に送る前に止めて、流す・書き換える・捨てる。#411）を
// 受けられる印。
const CapProxyHold = "proxy.hold"

// maxProxyScopes は同時に通せる単位の数。
const maxProxyScopes = 64

// wsScopePrefix はワークスペースの scope の頭。窓が決める scope には使えない。
const wsScopePrefix = "ws:"

var proxyScopeName = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// ProxyCADir はプロキシの認証局を置くフォルダ（kisui の状態を置くフォルダ）。`kisui proxy` も同じものを使う。
func ProxyCADir() (string, error) { return stateDir() }

type proxyScope struct {
	key   string
	wsID  string // ワークスペースの scope でなければ ""
	ln    net.Listener
	px    *proxy.Proxy
	store *proxy.Store
}

func (sc *proxyScope) port() int {
	if a, ok := sc.ln.Addr().(*net.TCPAddr); ok {
		return a.Port
	}
	return 0
}

// proxyScopeInfo は proxy.list の 1 行と、proxy.start の結果の頭。
type proxyScopeInfo struct {
	Scope       string `json:"scope"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Port        int    `json:"port"`
	// Recording は、間に入って記録しているか。false は、やめたあと中継だけしているワークスペースの scope。
	Recording bool `json:"recording"`
	// Holding は、要求を行き先に送る前に止めるのを入れているか（#411）。
	Holding bool `json:"holding"`
}

func (sc *proxyScope) info() proxyScopeInfo {
	return proxyScopeInfo{Scope: sc.key, WorkspaceID: sc.wsID, Port: sc.port(), Recording: sc.px.Intercepting(), Holding: sc.px.Holding()}
}

type proxyManager struct {
	srv *Server

	mu     sync.Mutex
	ca     *proxy.CA // 初めて使うときに読む（無ければ作る）
	scopes map[string]*proxyScope
	closed bool
}

func newProxyManager(srv *Server) *proxyManager {
	return &proxyManager{srv: srv, scopes: map[string]*proxyScope{}}
}

// loadCA は認証局を読む（mu を持って呼ぶ）。
func (m *proxyManager) loadCA() (*proxy.CA, error) {
	if m.ca != nil {
		return m.ca, nil
	}
	dir := m.srv.opts.ProxyCADir
	if dir == "" {
		return nil, errors.New("no folder for the certificate authority of the proxy")
	}
	ca, err := proxy.LoadOrCreateCA(dir)
	if err != nil {
		return nil, err
	}
	m.ca = ca
	return ca, nil
}

// newScope は ln で待ち受ける scope を作る（mu を持って呼ぶ）。動かすのは serve。
func (m *proxyManager) newScope(key, wsID string, ln net.Listener, ca *proxy.CA) *proxyScope {
	sc := &proxyScope{key: key, wsID: wsID, ln: ln}
	sc.store = proxy.NewStore(func(sum proxy.Summary) {
		m.srv.notifyOwner("proxy.flow", map[string]any{"scope": key, "flow": sum})
	})
	sc.px = proxy.New(proxy.Options{CA: ca, Store: sc.store, RootCAs: m.srv.opts.ProxyRootCAs, Log: m.srv.log.With("scope", key)})
	m.scopes[key] = sc
	return sc
}

func (m *proxyManager) serve(sc *proxyScope) {
	go func() {
		if err := sc.px.Serve(sc.ln); err != nil {
			m.srv.log.Warn("proxy", "scope", sc.key, "err", err)
		}
	}()
}

// start は key の scope を通し始める。もうあれば、記録をやめていたものを記録し直す。
func (m *proxyManager) start(key, wsID string) (*proxyScope, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, rpc.Errorf(rpc.CodeBusy, "server is shutting down")
	}
	if sc := m.scopes[key]; sc != nil {
		sc.px.SetIntercept(true)
		return sc, nil
	}
	if len(m.scopes) >= maxProxyScopes {
		return nil, rpc.Errorf(rpc.CodeBusy, "too many proxies are running (%d)", maxProxyScopes)
	}
	ca, err := m.loadCA()
	if err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "proxy: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "proxy: %v", err)
	}
	sc := m.newScope(key, wsID, ln, ca)
	m.serve(sc)
	m.srv.log.Info("proxy started", "scope", key, "addr", ln.Addr().String())
	return sc, nil
}

// stop は key の scope を通すのをやめる。ワークスペースの scope は、待ち受け口を残して中継だけにする。
func (m *proxyManager) stop(key string) bool {
	m.mu.Lock()
	sc := m.scopes[key]
	if sc != nil && sc.wsID == "" {
		delete(m.scopes, key)
	}
	m.mu.Unlock()
	if sc == nil {
		return false
	}
	if sc.wsID != "" {
		sc.px.SetIntercept(false)
	} else {
		sc.px.Close()
	}
	m.srv.log.Info("proxy stopped", "scope", key)
	return true
}

// closeWorkspace は、閉じたワークスペースの scope を待ち受け口ごと閉じる。
func (m *proxyManager) closeWorkspace(wsID string) {
	m.mu.Lock()
	sc := m.scopes[wsScopePrefix+wsID]
	delete(m.scopes, wsScopePrefix+wsID)
	m.mu.Unlock()
	if sc != nil {
		sc.px.Close()
	}
}

// shutdown は全部の待ち受け口を閉じる。
func (m *proxyManager) shutdown() {
	m.mu.Lock()
	m.closed = true
	all := m.scopes
	m.scopes = map[string]*proxyScope{}
	m.mu.Unlock()
	for _, sc := range all {
		sc.px.Close()
	}
}

// releaseHolds は、全部の scope で、要求を止めるのをやめる（止めている要求は、そのまま流れる）。窓がいなくなったときに呼ぶ：
// 流す・捨てるを決める相手がいないまま、ページやコマンドを待たせ続けないように。
func (m *proxyManager) releaseHolds() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sc := range m.scopes {
		sc.px.SetHold(false)
	}
}

func (m *proxyManager) get(key string) *proxyScope {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.scopes[key]
}

func (m *proxyManager) list() []proxyScopeInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]proxyScopeInfo, 0, len(m.scopes))
	for _, sc := range m.scopes {
		out = append(out, sc.info())
	}
	slices.SortFunc(out, func(a, b proxyScopeInfo) int { return strings.Compare(a.Scope, b.Scope) })
	return out
}

// envFor は、ワークスペース wsID の新しいペインに渡す環境変数。通していなければ（やめたあとも）nil。
func (m *proxyManager) envFor(wsID string) []string {
	if wsID == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sc := m.scopes[wsScopePrefix+wsID]
	if sc == nil || m.ca == nil || !sc.px.Intercepting() {
		return nil
	}
	return proxy.Env(fmt.Sprintf("127.0.0.1:%d", sc.port()), m.ca)
}

// proxyRequest は proxy.* のうち返事のあるもの。扱わないメソッドは handled == false。
func (ss *session) proxyRequest(req *rpc.Message) (res any, err error, handled bool) {
	if !strings.HasPrefix(req.Method, "proxy.") {
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	m := ss.srv.proxy
	var p struct {
		Scope       string `json:"scope"`
		WorkspaceID string `json:"workspaceId"`
		ID          int64  `json:"id"`
		// proxy.resend（#410）
		From      int64       `json:"from"`
		Method    string      `json:"method"`
		URL       string      `json:"url"`
		Headers   [][2]string `json:"headers"`
		Body      *string     `json:"body"`
		ConnectTo string      `json:"connectTo"`
		// proxy.hold・proxy.release（#411）
		On     bool   `json:"on"`
		Action string `json:"action"`
	}
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err), true
		}
	}
	noScope := func() error { return rpc.Errorf(rpc.CodeNotFound, "no such proxy: %s", p.Scope) }
	switch req.Method {
	case "proxy.list":
		return map[string]any{"scopes": m.list()}, nil, true
	case "proxy.start":
		key := p.Scope
		if p.WorkspaceID != "" {
			if _, ok := ss.srv.ws.folderOf(p.WorkspaceID); !ok {
				return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.WorkspaceID), true
			}
			key = wsScopePrefix + p.WorkspaceID
		} else if !proxyScopeName.MatchString(key) || strings.HasPrefix(key, wsScopePrefix) {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "scope or workspaceId is required"), true
		}
		sc, err := m.start(key, p.WorkspaceID)
		if err != nil {
			return nil, err, true
		}
		if p.WorkspaceID != "" {
			// 始めている間にワークスペースが閉じたら、残さない
			if _, ok := ss.srv.ws.folderOf(p.WorkspaceID); !ok {
				m.closeWorkspace(p.WorkspaceID)
				return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.WorkspaceID), true
			}
		}
		return struct {
			proxyScopeInfo
			Flows []proxy.Summary `json:"flows"`
		}{sc.info(), sc.store.Summaries()}, nil, true
	case "proxy.stop":
		if !m.stop(p.Scope) {
			return nil, noScope(), true
		}
		return struct{}{}, nil, true
	case "proxy.flows":
		sc := m.get(p.Scope)
		if sc == nil {
			return nil, noScope(), true
		}
		return map[string]any{"flows": sc.store.Summaries()}, nil, true
	case "proxy.detail":
		sc := m.get(p.Scope)
		if sc == nil {
			return nil, noScope(), true
		}
		d, ok := sc.store.Detail(p.ID)
		if !ok {
			return nil, rpc.Errorf(rpc.CodeNotFound, "no such flow: %d", p.ID), true
		}
		return d, nil, true
	case "proxy.resend":
		sc := m.get(p.Scope)
		if sc == nil {
			return nil, noScope(), true
		}
		r := proxy.Resend{From: p.From, Method: p.Method, URL: p.URL, Header: p.Headers, ConnectTo: p.ConnectTo}
		if p.Body != nil {
			b := []byte(*p.Body)
			r.Body = &b
		}
		sum, err := sc.px.Resend(r)
		if err != nil {
			return nil, resendError(err, p.From), true
		}
		return map[string]any{"flow": sum}, nil, true
	case "proxy.hold":
		sc := m.get(p.Scope)
		// やめたあと中継だけしているワークスペースは、通していないのと同じに扱う
		if sc == nil || !sc.px.Intercepting() {
			return nil, noScope(), true
		}
		sc.px.SetHold(p.On)
		ss.srv.log.Info("proxy hold", "scope", p.Scope, "on", p.On)
		return map[string]any{"holding": sc.px.Holding()}, nil, true
	case "proxy.release":
		sc := m.get(p.Scope)
		if sc == nil {
			return nil, noScope(), true
		}
		r := proxy.Release{ID: p.ID}
		switch p.Action {
		case "forward":
		case "drop":
			r.Drop = true
		case "edit":
			e := proxy.Resend{Method: p.Method, URL: p.URL, Header: p.Headers, ConnectTo: p.ConnectTo}
			if p.Body != nil {
				b := []byte(*p.Body)
				e.Body = &b
			}
			r.Edit = &e
		default:
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "action must be forward, edit or drop"), true
		}
		if err := sc.px.Release(r); err != nil {
			return nil, releaseError(err, p.ID), true
		}
		return struct{}{}, nil, true
	}
	return nil, rpc.Errorf(rpc.CodeMethodNotFound, "method not found: %s", req.Method), true
}

// ---- 引き継ぎ（handover.go）----
// 待ち受け口は fd ごと次の serve に渡す（環境変数にポートを持つペインが、引き継いだあとも通信できるように）。
// 記録と、通している最中の接続は渡さない（古い serve が終わると切れる）。要求を止めるのを入れていたこと（#411）も渡さない
// （止めていた要求は接続ごと切れる。次の serve は、止めない所から始まる）。

// handoverProxy は引き継ぐ scope 1 つ。
type handoverProxy struct {
	Scope     string `json:"scope"`
	Workspace string `json:"workspace,omitempty"`
	Recording bool   `json:"recording"`
	FD        int    `json:"fd"`
}

func (s *Server) collectProxy(st *handoverState, fds *fdList) error {
	m := s.proxy
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sc := range m.scopes {
		tl, ok := sc.ln.(*net.TCPListener)
		if !ok {
			continue
		}
		fd, err := fds.add(tl)
		if err != nil {
			return fmt.Errorf("proxy %s: %w", sc.key, err)
		}
		st.Proxy = append(st.Proxy, handoverProxy{Scope: sc.key, Workspace: sc.wsID, Recording: sc.px.Intercepting(), FD: fd})
	}
	slices.SortFunc(st.Proxy, func(a, b handoverProxy) int { return strings.Compare(a.Scope, b.Scope) })
	return nil
}

// adoptProxy は受け取った待ち受け口で scope を作り直す。動かし始めるのは startAdopted。
// 認証局が読めないときは、プロキシだけをあきらめる（ターミナルの引き継ぎは止めない）。
func (s *Server) adoptProxy(st *handoverState, ft *fdTable) {
	m := s.proxy
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, hp := range st.Proxy {
		f, err := ft.take(hp.FD, "proxy")
		if err != nil {
			s.log.Warn("handover: proxy", "scope", hp.Scope, "err", err)
			continue
		}
		ln, err := net.FileListener(f)
		f.Close()
		if err != nil {
			s.log.Warn("handover: proxy", "scope", hp.Scope, "err", err)
			continue
		}
		ca, err := m.loadCA()
		if err != nil {
			s.log.Warn("handover: proxy", "scope", hp.Scope, "err", err)
			ln.Close()
			continue
		}
		sc := m.newScope(hp.Scope, hp.Workspace, ln, ca)
		sc.px.SetIntercept(hp.Recording)
	}
}

// startAdoptedProxy は引き継いだ scope の待ち受けを始める。
func (s *Server) startAdoptedProxy() {
	m := s.proxy
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sc := range m.scopes {
		m.serve(sc)
	}
}

// releaseError は proxy.release の断り方。
func releaseError(err error, id int64) error {
	var bad *proxy.InvalidRequestError
	switch {
	case errors.Is(err, proxy.ErrNotHeld):
		return rpc.Errorf(rpc.CodeNotFound, "the request is not held: %d", id)
	case errors.As(err, &bad):
		return rpc.Errorf(rpc.CodeInvalidParams, "%v", err)
	}
	return rpc.Errorf(rpc.CodeInternalError, "%v", err)
}

// resendError は proxy.resend の断り方。
func resendError(err error, from int64) error {
	var bad *proxy.InvalidRequestError
	switch {
	case errors.Is(err, proxy.ErrNoFlow):
		return rpc.Errorf(rpc.CodeNotFound, "no such flow: %d", from)
	case errors.Is(err, proxy.ErrBusy):
		return rpc.Errorf(rpc.CodeBusy, "%v", err)
	case errors.Is(err, proxy.ErrBodyCut), errors.As(err, &bad):
		return rpc.Errorf(rpc.CodeInvalidParams, "%v", err)
	}
	return rpc.Errorf(rpc.CodeInternalError, "%v", err)
}
