// Package server は画面を持たない常駐プロセス「shj serve」の中身。
// Unix ソケットで JSON-RPC を話す。設計は docs/design/gui-protocol.md の 3 章。
//
// 今あるメソッドは session.* / server.info / term.*（term.go）/ workspace.*（workspace.go）/ tree.*・git.status（tree.go、treewatch.go、gitstat.go）/
// view.*・screen.*・theme.get・i18n.get・blob.get（view.go、view_diff.go）/ input.*・command.run・file.open（input.go）。
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/mm1995tk/shijimi-editor/core"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// Protocol はこのサーバーが話すプロトコルの版。major が違うとつながらない。minor は互換。
var Protocol = ProtocolVersion{Major: 3, Minor: 0}

// ProtocolVersion はプロトコルの版。
type ProtocolVersion struct {
	Major int `json:"major"`
	Minor int `json:"minor"`
}

// Shj はこの shj の版。
type Shj struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Channel string `json:"channel"` // "stable" か "nightly"
}

// Options は Listen に渡すもの。
type Options struct {
	SocketPath string
	Shj        Shj
	Logger     *slog.Logger // nil なら捨てる
	// IdleStop は GUI が何もつながらないままこの時間が過ぎたら止まる設定（[server] idle_stop_days）。0 なら止まらない。
	IdleStop  time.Duration
	IdleCheck time.Duration // 止まる時刻を調べる間隔。0 なら 1 分
	// StartDir は新しいワークスペースのプライマリターミナルが始まるフォルダ（[server] start_dir、絶対パス）。"" なら ~。
	StartDir string
	// StatePath はワークスペースの一覧を保存するファイル。"" なら保存も復元もしない。
	StatePath string
	// CwdInterval はシェルの cwd を読む間隔。0 なら 1 秒。
	CwdInterval time.Duration
	// TreeInterval は tree.watch のフォルダを見る間隔（0 なら 1 秒）、GitInterval は git の印を取り直す間隔（0 なら 3 秒）。
	TreeInterval time.Duration
	GitInterval  time.Duration
	Now          func() time.Time // nil なら time.Now。テストで差し替える
}

// Server は Unix ソケットで待ち受けるサーバー。
type Server struct {
	opts      Options
	log       *slog.Logger
	ln        net.Listener
	serverID  string
	startedAt time.Time

	mu         sync.Mutex
	sessions   map[*session]struct{}
	closed     bool      // shutdown が始まった。以後の接続は受けずに閉じる
	lastClient time.Time // 最後に GUI がつながっていた時刻。ゼロなら一度も無い
	owner      *session  // いま受けつけている GUI（session.hello を済ませた最新の接続）。無ければ nil
	wg         sync.WaitGroup
	terms      *termManager
	ws         *wsManager
	tree       *treeManager
	rev        int64           // サーバー全体の版（mu で守る）
	stopping   bool            // stop が始まった
	beforeStop []func()        // 止まる前に走らせる（AddBeforeStop）
	focus      Workspace       // ctl と ide の届け先。無ければ nil
	cores      Cores           // ワークスペースごとの core（SetCores）。無ければ nil
	screens    Screens         // 画面の作り手（SetScreens）。無ければ nil
	inputs     Inputs          // 入力の届け先（SetInputs）。無ければ nil
	screenKick chan struct{}   // ScreenChanged の知らせ（1 つまで溜める）
	screenMu   sync.Mutex      // 画面の配信（session.view と送る順）を守る
	ctlSrv     *core.CtlServer // StartControl で開く
	ideSrv     *core.IDEServer // StartIDE で開く
	primary    *primaryServer  // プライマリの shj の知らせを受ける口（Serve で開く）
}

// ErrRunning はすでに別の shj serve が動いているときのエラー。
var ErrRunning = errors.New("shj serve is already running")

// Listen はソケットを作って待ち受ける（0600）。同じ場所で別のサーバーが動いていれば ErrRunning。
// 残っているだけの古いソケットは作り直す。
func Listen(opts Options) (*Server, error) {
	if c, err := net.DialTimeout("unix", opts.SocketPath, time.Second); err == nil {
		c.Close()
		return nil, ErrRunning
	}
	_ = os.Remove(opts.SocketPath)
	ln, err := net.Listen("unix", opts.SocketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(opts.SocketPath, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		ln.Close()
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	srv := &Server{
		opts:       opts,
		log:        log,
		ln:         ln,
		serverID:   hex.EncodeToString(id),
		sessions:   map[*session]struct{}{},
		screenKick: make(chan struct{}, 1),
	}
	srv.startedAt = srv.now()
	srv.terms = newTermManager(srv)
	srv.ws = newWSManager(srv)
	srv.tree = newTreeManager(srv)
	return srv, nil
}

// ServerID はこのサーバーの 1 回の起動ごとの番号。
func (s *Server) ServerID() string { return s.serverID }

// Serve は ctx が終わるか Close されるまで接続を受ける。終わるとソケットを消す。
func (s *Server) Serve(ctx context.Context) error {
	stop := context.AfterFunc(ctx, func() { s.ln.Close() })
	defer stop()
	s.log.Info("serving", "socket", s.opts.SocketPath, "serverId", s.serverID, "pid", os.Getpid())
	idleDone := make(chan struct{})
	defer close(idleDone)
	s.ws.restore()
	go s.watchIdle(idleDone)
	go s.ws.watch(idleDone)
	go s.tree.watch(idleDone)
	go s.screenLoop(idleDone)
	s.startPrimary()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			s.shutdown()
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		s.accept(c)
	}
}

// Close は待ち受けをやめ、つながっている接続も閉じる。
func (s *Server) Close() {
	s.ln.Close()
	s.shutdown()
}

func (s *Server) shutdown() {
	_ = os.Remove(s.opts.SocketPath)
	s.mu.Lock()
	s.closed = true
	cs, is := s.ctlSrv, s.ideSrv
	s.ctlSrv, s.ideSrv = nil, nil
	var open []*session
	for ss := range s.sessions {
		open = append(open, ss)
	}
	s.mu.Unlock()
	for _, ss := range open {
		ss.conn.Close()
	}
	if cs != nil {
		cs.Close()
	}
	if is != nil {
		is.Close()
	}
	s.stopPrimary()
	s.terms.shutdown()
	s.wg.Wait()
}

func (s *Server) accept(c net.Conn) {
	ss := &session{srv: s}
	ss.conn = rpc.NewConnWith(c, rpc.JSON{}, ss.handle, rpc.Options{Ordered: isInputMethod})
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		ss.conn.Close()
		return
	}
	s.sessions[ss] = struct{}{}
	// Add と Wait の順はこのロックで決まる。
	s.wg.Go(func() {
		<-ss.conn.Done()
		s.mu.Lock()
		delete(s.sessions, ss)
		if s.owner == ss {
			s.owner = nil
		}
		s.lastClient = s.now()
		s.mu.Unlock()
		// 状態（ファイル・core・ターミナル）はそのまま残す。
		s.log.Info("client gone", "reason", fmt.Sprint(ss.conn.Err()))
		ss.conn.Close() // fd と Handler の終わりを待つ。Done のあとなので詰まらない
	})
	s.mu.Unlock()
	s.log.Info("client connected")
}

// lastClientAt は GUI が最後につながっていた時刻。つながっている間は今。一度も無ければ nil。
func (s *Server) lastClientAt() *time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) > 0 {
		t := s.now()
		return &t
	}
	if s.lastClient.IsZero() {
		return nil
	}
	t := s.lastClient
	return &t
}

// session は 1 本の接続の状態。
type session struct {
	srv   *Server
	conn  *rpc.Conn
	mu    sync.Mutex
	hello bool

	// 以下は srv.mu で守る。
	client      ClientInfo // session.hello で名乗ったもの
	connectedAt time.Time  // session.hello が通った時刻
	superseded  bool       // 後からつないだ GUI に引き継がれた。以後の要求は not_owner

	view *viewState // 画面の配信の状態（srv.screenMu で守る）。view.subscribe などで作る
}

// ClientInfo は GUI が session.hello で名乗る内容。
type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Kind    string `json:"kind"`
}

// Peer は引き継ぎの相手（session.hello の supersedes と session.superseded の by）。
type Peer struct {
	Client      ClientInfo `json:"client"`
	ConnectedAt time.Time  `json:"connectedAt"`
}

// HelloParams は session.hello のパラメータ。
type HelloParams struct {
	Protocol ProtocolVersion `json:"protocol"`
	Client   ClientInfo      `json:"client"`
	Encoding []string        `json:"encoding"`
	Resume   *struct {
		ServerID string `json:"serverId"`
		Rev      int64  `json:"rev"`
	} `json:"resume,omitempty"`
}

// HelloResult は session.hello の結果。workspaces は後の Issue で埋まる（今は空）。
type HelloResult struct {
	Protocol     ProtocolVersion `json:"protocol"`
	Encoding     string          `json:"encoding"`
	Shj          Shj             `json:"shj"`
	ServerID     string          `json:"serverId"`
	StartedAt    time.Time       `json:"startedAt"`
	Supersedes   *Peer           `json:"supersedes,omitempty"`
	Capabilities []string        `json:"capabilities"`
	Workspaces   []*wsInfo       `json:"workspaces"`
	Rev          int64           `json:"rev"`
}

// InfoResult は server.info の結果。idleStopAt は GUI がつながっている間と、止まらない設定（0）のとき null。
type InfoResult struct {
	Shj          Shj        `json:"shj"`
	ServerID     string     `json:"serverId"`
	PID          int        `json:"pid"`
	Uptime       int64      `json:"uptime"` // 秒
	LastClientAt *time.Time `json:"lastClientAt"`
	IdleStopAt   *time.Time `json:"idleStopAt"`
	Workspaces   int        `json:"workspaces"`
	Terminals    int        `json:"terminals"`
}

func (ss *session) handle(_ context.Context, req *rpc.Message) (any, error) {
	if req.IsNotification() {
		ss.termNotify(req)
		ss.viewNotify(req)
		return nil, nil // 知らない通知は無視する
	}
	if ss.isSuperseded() {
		return nil, errNotOwner()
	}
	if res, err, ok := ss.termRequest(req); ok {
		return res, err
	}
	if res, err, ok := ss.workspaceRequest(req); ok {
		return res, err
	}
	if res, err, ok := ss.viewRequest(req); ok {
		return res, err
	}
	if res, err, ok := ss.inputRequest(req); ok {
		return res, err
	}
	if res, err, ok := ss.treeRequest(req); ok {
		return res, err
	}
	if res, err, ok := ss.primaryRequest(req); ok {
		return res, err
	}
	switch req.Method {
	case "session.hello":
		return ss.helloReq(req)
	case "session.ping":
		return struct{}{}, nil
	case "session.bye":
		// GUI を閉じるだけ。shj とシェルは止めない。接続は GUI が閉じる。
		return struct{}{}, nil
	case "server.shutdown":
		if err := ss.needHello(); err != nil {
			return nil, err
		}
		return ss.srv.shutdownReq(req)
	case "server.info":
		if err := ss.needHello(); err != nil {
			return nil, err
		}
		s := ss.srv
		return InfoResult{
			Shj:          s.opts.Shj,
			ServerID:     s.serverID,
			PID:          os.Getpid(),
			Uptime:       int64(s.now().Sub(s.startedAt) / time.Second),
			LastClientAt: s.lastClientAt(),
			IdleStopAt:   s.idleStopAt(),
			Workspaces:   s.ws.count(),
			Terminals:    s.terms.count(),
		}, nil
	}
	return nil, rpc.Errorf(rpc.CodeMethodNotFound, "method not found: %s", req.Method)
}

func errNotOwner() *rpc.Error {
	return rpc.Errorf(rpc.CodeNotOwner, "another GUI took over this shj")
}

func (ss *session) isSuperseded() bool {
	ss.srv.mu.Lock()
	defer ss.srv.mu.Unlock()
	return ss.superseded
}

func (ss *session) needHello() error {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if !ss.hello {
		return rpc.Errorf(rpc.CodeInvalidRequest, "session.hello must come first")
	}
	return nil
}

func (ss *session) helloReq(req *rpc.Message) (any, error) {
	var p HelloParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
	}
	if p.Protocol.Major != Protocol.Major {
		e := rpc.Errorf(rpc.CodeIncompatibleProtocol, "incompatible protocol: server speaks major %d, client major %d", Protocol.Major, p.Protocol.Major)
		e.Data, _ = json.Marshal(map[string]any{"protocol": Protocol})
		return nil, e
	}
	// いまは json だけ。encoding を省いたら json とみなす。
	if len(p.Encoding) > 0 && !slices.Contains(p.Encoding, "json") {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "no common encoding: server supports json")
	}
	s := ss.srv
	now := time.Now()
	s.mu.Lock()
	if ss.superseded || s.closed {
		s.mu.Unlock()
		return nil, errNotOwner()
	}
	// 同じ接続からの hello のやり直しは引き継ぎではない。
	prev := s.owner
	if prev == ss {
		prev = nil
	}
	var sup *Peer
	if prev != nil {
		sup = &Peer{Client: prev.client, ConnectedAt: prev.connectedAt}
		prev.superseded = true
	}
	ss.client, ss.connectedAt = p.Client, now
	s.owner = ss
	s.mu.Unlock()
	ss.mu.Lock()
	ss.hello = true
	ss.mu.Unlock()
	if prev != nil {
		// この要求の Handler の中では閉じられない（自分を待って詰まる）ので別の goroutine で。
		// 前の GUI が出した返事前の要求は、閉じることで返事が届かず捨てられる。
		s.wg.Go(func() {
			_ = prev.conn.Notify("session.superseded", map[string]any{"by": Peer{Client: p.Client, ConnectedAt: now}})
			prev.conn.Close()
		})
	}
	wsl, _ := s.ws.snapshot()
	ss.srv.log.Info("hello", "client", p.Client.Name, "version", p.Client.Version, "kind", p.Client.Kind)
	return HelloResult{
		Protocol:     Protocol,
		Encoding:     "json",
		Shj:          s.opts.Shj,
		ServerID:     s.serverID,
		StartedAt:    s.startedAt,
		Supersedes:   sup,
		Capabilities: []string{},
		Workspaces:   wsl,
		Rev:          s.currentRev(),
	}, nil
}

// bumpRev はサーバー全体の版を 1 つ進める。
func (s *Server) bumpRev() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rev++
	return s.rev
}

func (s *Server) currentRev() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rev
}
