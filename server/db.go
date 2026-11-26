package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/buildinfo"
	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapDB は session.hello の capabilities に入れる、db.*（DB の接続の一覧と SQL の実行）を受けられる印。
const CapDB = "db"

// CapDBPermissions は capabilities に入れる、DB の権限（#381）を知っている印：db.query と db.schema の actor を読み、
// 設定の権限（[db.permissions]）に従う。この印の無い kisui serve は actor を読まずに、全部を人の要求として実行するので、
// エージェントとして頼む側（kisui db のコマンド）は、この印を確かめてから送る。
const CapDBPermissions = "db-permissions"

// CapDBSchema は capabilities に入れる、db.query の schema（タブの既定のスキーマ。#378）を読む印。この印の無い kisui serve は
// schema を黙って無視し、DB の既定のスキーマで実行する（書き込む文も）ので、窓は印を確かめてから既定のスキーマを選ばせる。
const CapDBSchema = "db-schema"

// CapDBStructure は capabilities に入れる、db.structure（1 つのテーブルの構造。#379）を受けられる印。窓は、この印の無い
// kisui serve のタブでは、テーブルの構造を頼まずに理由を出す。
const CapDBStructure = "db-structure"

// CapDBRemember は capabilities に入れる、db.remember（窓が覚えているパスワードを渡し直す）を受けられる印。この印のある
// kisui serve は、窓で打って覚えたパスワードを、その窓の接続が切れたとき・別の窓が持ち主になったときに全部忘れる。
// 窓は、この印の無い kisui serve には db.remember を送らず、パスワードを自分では覚えない。
const CapDBRemember = "db-remember"

// dbMaxRunning は同時に動かせる db.query の数。超えたら busy。
const dbMaxRunning = 8

// dbManager は db.* の要求が使うもの。DB への接続そのものは internal/db が受け持ち、ここは
// 「どの接続か」「パスワードはどれか」「動いている SQL はどれか」「どの SQL を実行したか（履歴）」だけを持つ。
//
// DB のログインは持ち続けない。db.query の 1 回ごとにログインし、終わったら切る（理由は internal/db の説明）。
// 覚えるのは、窓から渡されて通ったパスワードだけ（passwords の中。メモリだけで、ファイルにも引き継ぎにも渡さない）。
// 覚えているのは、渡した窓（持ち主の接続）がつながっている間だけ：その接続が切れたとき・別の接続が持ち主になったときに
// 全部忘れる（Server.forgetDBPasswords）。窓は自分のメモリにも覚えていて、つなぎ直したら db.remember で渡し直す。
type dbManager struct {
	// load は設定の [[db.connections]] を読む。db.* の要求のたびに呼ぶ（serve を止めずに接続を足せるように）。
	load      func() ([]config.DBConnection, []config.Problem)
	passwords *db.Passwords
	// history は接続ごとの SQL の履歴（ファイル。Options.DBHistoryDir が "" なら何も残さない）。
	history *db.History

	// now は今の時刻（Options.Now。テストで時計を進めるため）。
	now func() time.Time

	mu      sync.Mutex
	running map[*dbRun]struct{}
	// elevations は、時間を決めて強めている権限（#383。dbelevate.go）。メモリだけに持つ。
	elevations map[dbElevKey]dbElevation
}

// dbRun は動いている db.query の 1 つ。
type dbRun struct {
	id     string // 窓が付けた queryId。付けていなければ ""
	cancel context.CancelFunc
}

func newDBManager(opts Options) *dbManager {
	m := &dbManager{load: opts.DBConnections, passwords: opts.DBPasswords, history: &db.History{Dir: opts.DBHistoryDir}, running: map[*dbRun]struct{}{}, elevations: map[dbElevKey]dbElevation{}, now: opts.Now}
	if m.now == nil {
		m.now = time.Now
	}
	if m.load == nil {
		m.load = func() ([]config.DBConnection, []config.Problem) { return config.LoadDB(buildinfo.Suffix()) }
	}
	if m.passwords == nil {
		m.passwords = &db.Passwords{}
	}
	return m
}

// find は名前と環境の変種の接続を設定から探す。変種のある接続は、変種を付けずには見つからない
// （どの環境かを決めずに、どれかにつなぐことはしない）。無ければ not_found。
func (m *dbManager) find(name, variant string) (config.DBConnection, error) {
	conns, _ := m.load()
	c, ok := config.FindDB(conns, name, variant)
	if !ok {
		return c, rpc.Errorf(rpc.CodeNotFound, "no such connection: %s", config.DBConnection{Name: name, Variant: variant}.Label())
	}
	return c, nil
}

// begin は db.query を 1 つ動いているものに足す。返す ctx は、db.cancel か接続が切れると終わる。
// 終わったら done を呼ぶ。
func (m *dbManager) begin(ctx context.Context, id string) (_ context.Context, done func(), err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.running) >= dbMaxRunning {
		return nil, nil, rpc.Errorf(rpc.CodeBusy, "too many statements are running (the limit is %d)", dbMaxRunning)
	}
	if id != "" {
		for r := range m.running {
			if r.id == id {
				return nil, nil, rpc.Errorf(rpc.CodeInvalidParams, "queryId %q is in use", id)
			}
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	r := &dbRun{id: id, cancel: cancel}
	m.running[r] = struct{}{}
	return ctx, func() {
		cancel()
		m.mu.Lock()
		delete(m.running, r)
		m.mu.Unlock()
	}, nil
}

// cancel は queryId の db.query を取り消す。動いていなければ false。
func (m *dbManager) cancel(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for r := range m.running {
		if r.id == id && id != "" {
			r.cancel()
			return true
		}
	}
	return false
}

// run は c に password でログインして、そのログインで f を呼ぶ（終われば切る）。src は password の出どころで、
// 窓から渡されて通ったものは覚え（remember を呼ぶ）、覚えていて断られたものは忘れる。
func (m *dbManager) run(ctx context.Context, c config.DBLogin, password string, src db.Source, remember func(), f func(db.Session) error) error {
	sess, err := db.Open(ctx, c, password)
	if err != nil {
		if e, ok := errors.AsType[*db.Error](err); ok && e.Kind == db.KindAuth && src.Typed() {
			m.passwords.Forget(c)
		}
		return err
	}
	defer sess.Close()
	if src == db.SourceRequest {
		remember()
	}
	return f(sess)
}

// rememberDBPassword は、窓の接続 from が渡したパスワードを覚える。from が今の持ち主でなければ覚えない：
// 切れた接続・持ち主でなくなった接続の、返事を待っていた要求が後から通っても、忘れたあとに覚え直さない。
// 持ち主が替わるのと同じロック（mu）の中で確かめるので、forgetDBPasswords と前後しない。覚えたら true。
func (s *Server) rememberDBPassword(from *session, c config.DBLogin, password string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if from == nil || s.owner != from {
		return false
	}
	s.db.passwords.Remember(c, password)
	return true
}

// forgetDBPasswords は、窓で打って覚えたパスワードを全部忘れる。持ち主の接続が切れたときと、別の接続が持ち主に
// なったときに、mu を持ったまま呼ぶ（持ち主が替わるのと同時に忘れる）。キーチェーンとファイルのパスワードには触らない。
func (s *Server) forgetDBPasswords() {
	s.db.passwords.ForgetAll()
}

// dbLogin は db.query と db.schema の共通の引数。
type dbLogin struct {
	Connection string `json:"connection"`
	// Variant は環境の変種の名前。変種の無い接続では省く（""）。
	Variant string `json:"variant"`
	// Password は窓で入力されたパスワード。省いたとき（nil）と空文字（パスワード無しでログインする）は違う。
	Password *string `json:"password"`
	QueryID  string  `json:"queryId"`
	// Actor は、誰の要求か：省く（""）か "human" は人（窓）、"agent" はコーディングエージェント（kisui db のコマンド）。
	// 権限はこれで決まる（config.DBConnection.Access）。
	Actor string `json:"actor"`
	// from は、この要求を送った窓の接続（ペインの中のコマンド kisui db の頼みでは nil）。渡されて通ったパスワードは、
	// from が持ち主の間だけ覚える（Server.rememberDBPassword）。
	from *session
}

// dbActor は要求の actor を読む。知らない値は、人として通さずに断る（invalid_params）。
func dbActor(s string) (config.DBActor, error) {
	switch s {
	case "", string(config.DBHuman):
		return config.DBHuman, nil
	case string(config.DBAgent):
		return config.DBAgent, nil
	}
	return "", rpc.Errorf(rpc.CodeInvalidParams, "actor must be %q or %q: %q", config.DBHuman, config.DBAgent, s)
}

// access は、actor が c にしてよいこと。権限の判定はここだけを通る。actor の権限を時間を決めて強めている間（#383。
// dbelevate.go）は、c の権限を強めた先に差し替えてから聞く。
func (m *dbManager) access(c config.DBConnection, actor config.DBActor) config.DBAccess {
	return m.elevated(c, actor).Access(actor)
}

// errDBDenied は、権限が実行を許さないときの denied。data は {actor, permission}（permission は使った権限の名前。
// 設定に書いていなければ ""）。
func errDBDenied(c config.DBConnection, a config.DBAccess) *rpc.Error {
	e := rpc.Errorf(rpc.CodeDenied, "the permission of the %s does not allow running SQL on the connection %s", a.Actor, c.Label())
	e.Data, _ = json.Marshal(map[string]any{"actor": a.Actor, "permission": a.Permission})
	return e
}

// dbWith は p の接続にログインして f を呼ぶ。接続を探す・権限を確かめる・動いているものに足す（db.cancel で止められる）・
// パスワードを探す・間違いを返事（*rpc.Error）にする、は db.query と db.schema で同じ。what はログに書く要求の名前。
// 窓の要求（dbRequest）も、ペインの中のコマンド kisui db（dbcmd.go）も、ここを通る。
//
// run は、SQL を実行する要求か（db.query）。実行の段階が「しない」なら、DB につながずに denied で断る。
// スキーマの一覧（run が false）は段階に関わらず通す（データの行ではなく、テーブルと列の名前と型だけなので）。
// ログインは、p.Actor のユーザーで、段階が「自由」でなければ読むだけ。f に渡す接続は設定のもの（履歴の鍵と種類に使う）。
func (s *Server) dbWith(ctx context.Context, p dbLogin, what string, run bool, f func(context.Context, config.DBConnection, db.Session) error) error {
	m := s.db
	actor, err := dbActor(p.Actor)
	if err != nil {
		return err
	}
	conf, err := m.find(p.Connection, p.Variant)
	if err != nil {
		return err
	}
	acc := m.access(conf, actor)
	if run && acc.Run == config.DBRunNone {
		return errDBDenied(conf, acc)
	}
	c := conf.Login(acc)
	ctx, done, err := m.begin(ctx, p.QueryID)
	if err != nil {
		return err
	}
	defer done()
	password, src, err := m.passwords.Find(ctx, c, p.Password)
	if err != nil {
		if c.AgentUser {
			return errPasswordRequired("missing", "", "a password is required for the agent's user "+c.User+" of the connection "+conf.Label())
		}
		return errPasswordRequired("missing", "", "a password is required for the connection "+conf.Label())
	}
	remember := func() { s.rememberDBPassword(p.from, c, password) }
	err = m.run(ctx, c, password, src, remember, func(sess db.Session) error { return f(ctx, conf, sess) })
	if err != nil {
		// SQL とパスワードはログに書かない。
		s.log.Info(what+" failed", "connection", c.Name, "variant", c.Variant, "actor", actor)
		return dbQueryError(ctx, err, src)
	}
	return nil
}

// isDBRequest は、method が db.* の要求か。
func isDBRequest(req *rpc.Message) bool {
	return !req.IsNotification() && strings.HasPrefix(req.Method, "db.")
}

// dbRequest は db.* を振り分ける。ほかの要求と違い、srv.opMu の読みロックの外で呼ぶ：SQL は長くかかることがあり、
// ロックを持ったままだと、その間 serve の引き継ぎ（書きロックを待つ）と、引き継ぎを待つ全部の要求が止まる。
// db.* は serve の状態（ワークスペース・ターミナル）に触らないので、ロックは要らない。
// 引き継ぎで古い serve が終わると、動いていた SQL は接続が切れて取り消される。
func (ss *session) dbRequest(ctx context.Context, req *rpc.Message) (any, error) {
	if ss.srv.isHandedOver() {
		return nil, errHandedOverRPC()
	}
	if ss.isSuperseded() {
		return nil, errNotOwner()
	}
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	switch req.Method {
	case "db.connections":
		return ss.srv.dbConnections(), nil
	case "db.query":
		return ss.dbQueryReq(ctx, req)
	case "db.cancel":
		return ss.dbCancelReq(req)
	case "db.schema":
		return ss.dbSchemaReq(ctx, req)
	case "db.structure":
		return ss.dbStructureReq(ctx, req)
	case "db.history":
		return ss.dbHistoryReq(req)
	case "db.elevate":
		return ss.dbElevateReq(req)
	case "db.elevateEnd":
		return ss.dbElevateEndReq(req)
	case "db.remember":
		return ss.dbRememberReq(req)
	}
	return nil, rpc.Errorf(rpc.CodeMethodNotFound, "method not found: %s", req.Method)
}

// DBConnectionInfo は db.connections が返す接続の 1 つ。設定に書いたものだけで、パスワードは持たない
// （config.DBConnection にパスワードの欄が無いので、入りようがない）。
// 環境の変種のある接続は、変種ごとに 1 つ（Name が同じで Variant が違うものが、設定に書いた順に続く）。
type DBConnectionInfo struct {
	Name     string `json:"name"`
	Variant  string `json:"variant"` // 環境の変種の名前。変種の無い接続は ""
	Kind     string `json:"kind"`    // "postgres" か "mysql"
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Database string `json:"database"` // 書いていなければ ""
	// ReadOnly は、人（窓）の実行が「読むだけ」か（Human.Run が "read"）。権限を書いていない接続では、設定の read-only。
	ReadOnly bool `json:"readOnly"`
	// Human と Agent は、人とコーディングエージェントがこの接続にしてよいこと（設定の権限と read-only を合わせた結果）。
	Human DBHumanAccess `json:"human"`
	Agent DBAgentAccess `json:"agent"`
}

// DBHumanAccess は、人がある接続にしてよいこと。
type DBHumanAccess struct {
	Permission string       `json:"permission"` // 使っている権限の名前。設定に書いていなければ ""
	Run        config.DBRun `json:"run"`        // "none"・"read"・"free"
	// Elevate は、この権限を時間を決めて強められること（#383。強められなければ無い）。Elevated は、今強めていること
	// （強めていなければ無い）。強めている間、Permission と Run は強めた先のもの。
	Elevate  *DBElevate  `json:"elevate,omitempty"`
	Elevated *DBElevated `json:"elevated,omitempty"`
}

// DBAgentAccess は、コーディングエージェントがある接続にしてよいこと。
type DBAgentAccess struct {
	Permission string       `json:"permission"`
	Run        config.DBRun `json:"run"`
	// Propose は、DB のタブの入力欄に SQL を書いてよいか。
	Propose bool `json:"propose"`
	// User は、エージェントがログインする DB のユーザー（権限に agent-user が無ければ、接続の user と同じ）。
	User string `json:"user"`
	// Elevate と Elevated は DBHumanAccess と同じ。
	Elevate  *DBElevate  `json:"elevate,omitempty"`
	Elevated *DBElevated `json:"elevated,omitempty"`
}

// DBConnectionsResult は db.connections の結果。
type DBConnectionsResult struct {
	Connections []DBConnectionInfo `json:"connections"`
	// Problems は設定の [[db.connections]] の間違い（「ファイル: キー: 理由」。serve の ui-language の言葉）。
	// 間違いのある接続は Connections に入らない。
	Problems []string `json:"problems"`
}

// dbConnections は db.connections：このマシンの設定に書いた接続の一覧。
func (s *Server) dbConnections() DBConnectionsResult {
	conns, probs := s.db.load()
	res := DBConnectionsResult{Connections: make([]DBConnectionInfo, len(conns)), Problems: make([]string, len(probs))}
	for i, c := range conns {
		res.Connections[i] = s.dbConnectionInfo(c)
	}
	for i, p := range probs {
		res.Problems[i] = p.Text()
	}
	return res
}

// dbConnectionInfo は、設定の接続 c を、db.connections に入れる形にする（権限を合わせた結果と、強めている状態）。
func (s *Server) dbConnectionInfo(c config.DBConnection) DBConnectionInfo {
	h, a := s.db.access(c, config.DBHuman), s.db.access(c, config.DBAgent)
	info := DBConnectionInfo{
		Name: c.Name, Variant: c.Variant, Kind: c.Kind, Host: c.Host, Port: c.Port, User: c.User, Database: c.Database,
		ReadOnly: h.Run == config.DBRunRead,
		Human:    DBHumanAccess{Permission: h.Permission, Run: h.Run},
		Agent:    DBAgentAccess{Permission: a.Permission, Run: a.Run, Propose: a.Propose, User: a.User},
	}
	info.Human.Elevate, info.Human.Elevated = s.db.elevateInfo(c, config.DBHuman)
	info.Agent.Elevate, info.Agent.Elevated = s.db.elevateInfo(c, config.DBAgent)
	return info
}

// dbQueryParams は db.query の引数。
type dbQueryParams struct {
	dbLogin
	SQL     string `json:"sql"`
	MaxRows int    `json:"maxRows"`
	// Offset は、前に実行した結果の続きのページ（#373）。0 より大きければ、SQL を包んで（internal/db の wrap.go）、
	// その行数の後から読む。
	Offset int `json:"offset"`
	// OrderBy は、結果の列の位置（1 が最初の列）での並べ替え（#377）。0 か省けば並べ替えない。Desc は降順。
	// SQL を包んで ORDER BY を付ける（internal/db の wrap.go）ので、全部の行が並び、offset のページもその順になる。
	OrderBy int  `json:"orderBy"`
	Desc    bool `json:"desc"`
	// Rerun は、前に実行した SQL を読み直すだけの実行（ページ・並べ替え・並べ替えをやめる）。履歴に残さない。
	Rerun bool `json:"rerun"`
	// Schema は、スキーマを書かない名前を先に探すスキーマ（#378。DB のタブで選んだもの）。省くか "" なら、DB の既定のまま。
	// ログインは 1 つの文ごとなので、実行のたびに設定する（internal/db の QueryOptions.Schema）。
	Schema string `json:"schema"`
}

// dbQueryReq は db.query：接続に SQL を 1 つ実行して結果を返す。結果の形は db.Result。
func (ss *session) dbQueryReq(ctx context.Context, req *rpc.Message) (any, error) {
	var p dbQueryParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	p.from = ss
	return ss.srv.dbQuery(ctx, p)
}

// dbQuery は p の接続に SQL を 1 つ実行する。間違いは *rpc.Error。
func (s *Server) dbQuery(ctx context.Context, p dbQueryParams) (*db.Result, error) {
	if strings.TrimSpace(p.SQL) == "" {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "sql is empty")
	}
	if p.MaxRows < 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "maxRows is negative")
	}
	if p.Offset < 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "offset is negative")
	}
	if p.OrderBy < 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "orderBy is negative")
	}
	var res *db.Result
	err := s.dbWith(ctx, p.dbLogin, "db.query", true, func(ctx context.Context, c config.DBConnection, sess db.Session) error {
		// 履歴に足すのは、ログインが通って SQL を DB に送ったものだけ。ログインできなかった SQL は実行していないうえ、
		// password_required のあとに窓が送り直すと同じ SQL が 2 つ残ってしまう。ページを切り替えるための実行（offset あり）と並べ替えるための実行（orderBy あり）も
		// 残さない：同じ SQL の続きを読むだけで、ページを送るたびに同じ SQL が並んでしまう。
		at := s.now()
		var err error
		res, err = sess.Query(ctx, p.SQL, db.QueryOptions{MaxRows: p.MaxRows, Offset: p.Offset, OrderBy: p.OrderBy, Desc: p.Desc, Schema: p.Schema})
		if p.Offset > 0 || p.OrderBy > 0 || p.Rerun {
			return err
		}
		// エージェントの文も、人の文と同じ履歴に残す（エージェントが何を実行したかを、人が後から見られるように）。
		// どちらの文かは Actor で分かる。
		entry := db.HistoryEntry{SQL: p.SQL, At: at, OK: err == nil}
		if p.Actor == string(config.DBAgent) {
			entry.Actor = p.Actor
		}
		if herr := s.db.history.Add(db.HistoryKey(c), entry); herr != nil {
			// 履歴に残せなくても、SQL の結果は返す。
			s.log.Warn("db history", "connection", c.Name, "variant", c.Variant, "err", herr)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// dbSchemaReq は db.schema：接続のスキーマ・テーブル（ビューを含む）・列の一覧。結果の形は db.Catalog。
func (ss *session) dbSchemaReq(ctx context.Context, req *rpc.Message) (any, error) {
	var p dbLogin
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	p.from = ss
	return ss.srv.dbSchema(ctx, p)
}

// dbSchema は p の接続のスキーマの一覧を読む。間違いは *rpc.Error。
func (s *Server) dbSchema(ctx context.Context, p dbLogin) (*db.Catalog, error) {
	var cat *db.Catalog
	err := s.dbWith(ctx, p, "db.schema", false, func(ctx context.Context, c config.DBConnection, sess db.Session) error {
		var err error
		cat, err = db.ReadCatalog(ctx, sess, c.Kind)
		return err
	})
	if err != nil {
		return nil, err
	}
	return cat, nil
}

// dbStructureParams は db.structure の引数。
type dbStructureParams struct {
	dbLogin
	// Schema と Table は、構造を見るテーブル（ビュー）。db.schema の一覧の名前のまま（引用符を付けない）。
	Schema string `json:"schema"`
	Table  string `json:"table"`
}

// dbStructureReq は db.structure：1 つのテーブル（ビュー）の構造（列・インデックス・外部キー。#379）。結果の形は db.Structure。
func (ss *session) dbStructureReq(ctx context.Context, req *rpc.Message) (any, error) {
	var p dbStructureParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	p.from = ss
	return ss.srv.dbStructure(ctx, p)
}

// dbStructure は p の接続の、p のテーブルの構造を読む。権限は db.schema と同じで、実行の段階に関わらず通す
// （データの行ではなく、列・インデックス・外部キーの定義だけなので）。間違いは *rpc.Error。
func (s *Server) dbStructure(ctx context.Context, p dbStructureParams) (*db.Structure, error) {
	if p.Table == "" {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "table is empty")
	}
	var st *db.Structure
	err := s.dbWith(ctx, p.dbLogin, "db.structure", false, func(ctx context.Context, c config.DBConnection, sess db.Session) error {
		var err error
		st, err = db.ReadStructure(ctx, sess, c.Kind, p.Schema, p.Table)
		return err
	})
	if err != nil {
		return nil, err
	}
	return st, nil
}

// DBHistoryResult は db.history の結果。
type DBHistoryResult struct {
	// Entries は新しい順。
	Entries []db.HistoryEntry `json:"entries"`
}

// dbHistoryReq は db.history：接続で実行した SQL の履歴（新しい順）。DB にはつながない。
func (ss *session) dbHistoryReq(req *rpc.Message) (any, error) {
	var p struct {
		Connection string `json:"connection"`
		Variant    string `json:"variant"`
		Limit      int    `json:"limit"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	if p.Limit < 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "limit is negative")
	}
	m := ss.srv.db
	c, err := m.find(p.Connection, p.Variant)
	if err != nil {
		return nil, err
	}
	list, err := m.history.List(db.HistoryKey(c), p.Limit)
	if err != nil {
		ss.srv.log.Warn("db history", "connection", c.Name, "variant", c.Variant, "err", err)
		return nil, rpc.Errorf(rpc.CodeInternalError, "the history could not be read: %v", err)
	}
	return DBHistoryResult{Entries: list}, nil
}

// dbRememberParams は db.remember の引数：窓が覚えているパスワードと、それを打ったときの接続の行き先。
type dbRememberParams struct {
	Connection string `json:"connection"`
	Variant    string `json:"variant"`
	// Kind・Host・Port・User は、パスワードを打ったときに db.connections が返していた、その接続の種類・サーバー・ユーザー。
	Kind string `json:"kind"`
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
	// Password は覚えているパスワード。空文字もパスワード（パスワード無しでログインする）。省くと invalid_params。
	Password *string `json:"password"`
}

// DBRememberResult は db.remember の結果。
type DBRememberResult struct {
	// Remembered は、覚えたか。接続が設定に無い・種類かサーバーかユーザーが変わっていたら false（窓は、覚えていたものを捨てる）。
	Remembered bool `json:"remembered"`
}

// dbRememberReq は db.remember：窓が、前に打って通ったパスワードを、つなぎ直したあとに渡し直す。kisui serve は、持ち主の
// 接続が切れると覚えたパスワードを忘れるので、窓がつなぎ直したら、人が打ち直さなくても kisui db のコマンドがまた通るように。
// DB にはつながない（通るかは、次に使うときに分かる。断られたら、ほかの覚えたパスワードと同じに忘れる）。
//
// 覚えるのは、今の設定の接続が、パスワードを打ったときと同じ行き先（db.SameLogin）のときだけ：設定を書き換えたあとに、
// 前の行き先のパスワードを別のサーバーに送らない。覚える先は、人のログイン（接続の user）。
func (ss *session) dbRememberReq(req *rpc.Message) (any, error) {
	var p dbRememberParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	if p.Password == nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "password is missing")
	}
	s := ss.srv
	conns, _ := s.db.load()
	conf, ok := config.FindDB(conns, p.Connection, p.Variant)
	if !ok {
		return DBRememberResult{}, nil
	}
	c := conf.Login(s.db.access(conf, config.DBHuman))
	was := config.DBLogin{Name: p.Connection, Variant: p.Variant, Kind: p.Kind, Host: p.Host, Port: p.Port, User: p.User}
	if !db.SameLogin(c, was) {
		return DBRememberResult{}, nil
	}
	if !s.rememberDBPassword(ss, c, *p.Password) {
		// この要求を受けてから、持ち主でなくなった。窓が覚えているものは、捨てさせない（remembered: false にしない）。
		return nil, errNotOwner()
	}
	return DBRememberResult{Remembered: true}, nil
}

// errPasswordRequired は password_required を作る。reason は "missing"（どこにも無い）か "rejected"（DB が断った）。
// source は、断られたパスワードを見つけた場所（db.SourceKeychain か db.SourceFile）。入力したものが断られたときと
// "missing" では ""（data に付けない）。
func errPasswordRequired(reason string, source db.Source, message string) *rpc.Error {
	e := rpc.Errorf(rpc.CodePasswordRequired, "%s", message)
	data := map[string]any{"reason": reason}
	if source != "" {
		data["passwordSource"] = source
	}
	e.Data, _ = json.Marshal(data)
	return e
}

// dbQueryError は db.Open・Session.Query の間違いを、窓への返事にする。
//   - パスワードを DB が断った：password_required（reason は "rejected"）。窓は聞き直す。入力されたものは、次から
//     キーチェーン・ファイルで見つけたものより先に使う（db.Passwords）。見つけたものが断られたなら、data の
//     passwordSource にその場所（"keychain" か "file"）を付け、窓は聞く画面に出す。
//   - それ以外：db_error。data は {kind, sqlState?}。kind は db.ErrorKind。
func dbQueryError(ctx context.Context, err error, src db.Source) *rpc.Error {
	e, ok := errors.AsType[*db.Error](err)
	if !ok {
		return rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	// ログインの途中で取り消されたものも、取り消しとして返す。
	e = db.Cancelled(ctx, e)
	if e.Kind == db.KindAuth {
		var found db.Source
		if !src.Typed() {
			found = src
		}
		return errPasswordRequired("rejected", found, e.Message)
	}
	data := map[string]any{"kind": e.Kind}
	if e.SQLState != "" {
		data["sqlState"] = e.SQLState
	}
	re := rpc.Errorf(rpc.CodeDBError, "%s", e.Message)
	re.Data, _ = json.Marshal(data)
	return re
}

// dbCancelReq は db.cancel：queryId を付けた db.query を取り消す。DB にその SQL を止めさせ、
// db.query は db_error（kind は "cancelled"）で返る。
func (ss *session) dbCancelReq(req *rpc.Message) (any, error) {
	var p struct {
		QueryID string `json:"queryId"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	if !ss.srv.db.cancel(p.QueryID) {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such running statement: %s", p.QueryID)
	}
	return struct{}{}, nil
}

// DBHistoryDir は DB の SQL の履歴を置くフォルダ（serve.log と同じフォルダの db-history）。
func DBHistoryDir() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "db-history"), nil
}
