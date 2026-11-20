package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"

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

// dbMaxRunning は同時に動かせる db.query の数。超えたら busy。
const dbMaxRunning = 8

// dbManager は db.* の要求が使うもの。DB への接続そのものは internal/db が受け持ち、ここは
// 「どの接続か」「パスワードはどれか」「動いている SQL はどれか」「どの SQL を実行したか（履歴）」だけを持つ。
//
// DB のログインは持ち続けない。db.query の 1 回ごとにログインし、終わったら切る（理由は internal/db の説明）。
// 覚えるのは、窓から渡されて通ったパスワードだけ（passwords の中。メモリだけで、ファイルにも引き継ぎにも渡さない）。
type dbManager struct {
	// load は設定の [[db.connections]] を読む。db.* の要求のたびに呼ぶ（serve を止めずに接続を足せるように）。
	load      func() ([]config.DBConnection, []config.Problem)
	passwords *db.Passwords
	// history は接続ごとの SQL の履歴（ファイル。Options.DBHistoryDir が "" なら何も残さない）。
	history *db.History

	mu      sync.Mutex
	running map[*dbRun]struct{}
}

// dbRun は動いている db.query の 1 つ。
type dbRun struct {
	id     string // 窓が付けた queryId。付けていなければ ""
	cancel context.CancelFunc
}

func newDBManager(opts Options) *dbManager {
	m := &dbManager{load: opts.DBConnections, passwords: opts.DBPasswords, history: &db.History{Dir: opts.DBHistoryDir}, running: map[*dbRun]struct{}{}}
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
// 窓から渡されて通ったものは覚え、覚えていて断られたものは忘れる。
func (m *dbManager) run(ctx context.Context, c config.DBLogin, password string, src db.Source, f func(db.Session) error) error {
	sess, err := db.Open(ctx, c, password)
	if err != nil {
		if e, ok := errors.AsType[*db.Error](err); ok && e.Kind == db.KindAuth && src.Typed() {
			m.passwords.Forget(c)
		}
		return err
	}
	defer sess.Close()
	if src == db.SourceRequest {
		m.passwords.Remember(c, password)
	}
	return f(sess)
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

// access は、actor が c にしてよいこと。権限の判定はここだけを通る（一時的に権限を変える仕組みを足すなら、ここで
// c の権限を差し替えてから聞く）。
func (m *dbManager) access(c config.DBConnection, actor config.DBActor) config.DBAccess {
	return c.Access(actor)
}

// errDBDenied は、権限が実行を許さないときの denied。data は {actor, permission}（permission は使った権限の名前。
// 設定に書いていなければ ""）。
func errDBDenied(c config.DBConnection, a config.DBAccess) *rpc.Error {
	e := rpc.Errorf(rpc.CodeDenied, "the permission of the %s does not allow running SQL on the connection %s", a.Actor, c.Label())
	e.Data, _ = json.Marshal(map[string]any{"actor": a.Actor, "permission": a.Permission})
	return e
}

// dbWith は p の接続にログインして f を呼ぶ。接続を探す・権限を確かめる・動いているものに足す（db.cancel で止められる）・
// パスワードを探す・間違いを窓への返事にする、は db.query と db.schema で同じ。what はログに書く要求の名前。
//
// run は、SQL を実行する要求か（db.query）。実行の段階が「しない」なら、DB につながずに denied で断る。
// スキーマの一覧（run が false）は段階に関わらず通す（データの行ではなく、テーブルと列の名前と型だけなので）。
// ログインは、p.Actor のユーザーで、段階が「自由」でなければ読むだけ。f に渡す接続は設定のもの（履歴の鍵と種類に使う）。
func (ss *session) dbWith(ctx context.Context, p dbLogin, what string, run bool, f func(context.Context, config.DBConnection, db.Session) error) error {
	m := ss.srv.db
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
			return errPasswordRequired("missing", "a password is required for the agent's user "+c.User+" of the connection "+conf.Label())
		}
		return errPasswordRequired("missing", "a password is required for the connection "+conf.Label())
	}
	err = m.run(ctx, c, password, src, func(s db.Session) error { return f(ctx, conf, s) })
	if err != nil {
		// SQL とパスワードはログに書かない。
		ss.srv.log.Info(what+" failed", "connection", c.Name, "variant", c.Variant, "actor", actor)
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
		return ss.dbConnectionsReq()
	case "db.query":
		return ss.dbQueryReq(ctx, req)
	case "db.cancel":
		return ss.dbCancelReq(req)
	case "db.schema":
		return ss.dbSchemaReq(ctx, req)
	case "db.history":
		return ss.dbHistoryReq(req)
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
}

// DBAgentAccess は、コーディングエージェントがある接続にしてよいこと。
type DBAgentAccess struct {
	Permission string       `json:"permission"`
	Run        config.DBRun `json:"run"`
	// Propose は、DB のタブの入力欄に SQL を書いてよいか。
	Propose bool `json:"propose"`
	// User は、エージェントがログインする DB のユーザー（権限に agent-user が無ければ、接続の user と同じ）。
	User string `json:"user"`
}

// DBConnectionsResult は db.connections の結果。
type DBConnectionsResult struct {
	Connections []DBConnectionInfo `json:"connections"`
	// Problems は設定の [[db.connections]] の間違い（「ファイル: キー: 理由」。serve の ui-language の言葉）。
	// 間違いのある接続は Connections に入らない。
	Problems []string `json:"problems"`
}

// dbConnectionsReq は db.connections：このマシンの設定に書いた接続の一覧。
func (ss *session) dbConnectionsReq() (any, error) {
	conns, probs := ss.srv.db.load()
	res := DBConnectionsResult{Connections: make([]DBConnectionInfo, len(conns)), Problems: make([]string, len(probs))}
	for i, c := range conns {
		h, a := ss.srv.db.access(c, config.DBHuman), ss.srv.db.access(c, config.DBAgent)
		res.Connections[i] = DBConnectionInfo{
			Name: c.Name, Variant: c.Variant, Kind: c.Kind, Host: c.Host, Port: c.Port, User: c.User, Database: c.Database,
			ReadOnly: h.Run == config.DBRunRead,
			Human:    DBHumanAccess{Permission: h.Permission, Run: h.Run},
			Agent:    DBAgentAccess{Permission: a.Permission, Run: a.Run, Propose: a.Propose, User: a.User},
		}
	}
	for i, p := range probs {
		res.Problems[i] = p.Text()
	}
	return res, nil
}

// dbQueryReq は db.query：接続に SQL を 1 つ実行して結果を返す。結果の形は db.Result。
func (ss *session) dbQueryReq(ctx context.Context, req *rpc.Message) (any, error) {
	var p struct {
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
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
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
	err := ss.dbWith(ctx, p.dbLogin, "db.query", true, func(ctx context.Context, c config.DBConnection, s db.Session) error {
		// 履歴に足すのは、ログインが通って SQL を DB に送ったものだけ。ログインできなかった SQL は実行していないうえ、
		// password_required のあとに窓が送り直すと同じ SQL が 2 つ残ってしまう。ページを切り替えるための実行（offset あり）と並べ替えるための実行（orderBy あり）も
		// 残さない：同じ SQL の続きを読むだけで、ページを送るたびに同じ SQL が並んでしまう。
		at := ss.srv.now()
		var err error
		res, err = s.Query(ctx, p.SQL, db.QueryOptions{MaxRows: p.MaxRows, Offset: p.Offset, OrderBy: p.OrderBy, Desc: p.Desc, Schema: p.Schema})
		if p.Offset > 0 || p.OrderBy > 0 || p.Rerun {
			return err
		}
		if herr := ss.srv.db.history.Add(db.HistoryKey(c), db.HistoryEntry{SQL: p.SQL, At: at, OK: err == nil}); herr != nil {
			// 履歴に残せなくても、SQL の結果は返す。
			ss.srv.log.Warn("db history", "connection", c.Name, "variant", c.Variant, "err", herr)
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
	var cat *db.Catalog
	err := ss.dbWith(ctx, p, "db.schema", false, func(ctx context.Context, c config.DBConnection, s db.Session) error {
		var err error
		cat, err = db.ReadCatalog(ctx, s, c.Kind)
		return err
	})
	if err != nil {
		return nil, err
	}
	return cat, nil
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

// errPasswordRequired は password_required を作る。reason は "missing"（どこにも無い）か "rejected"（入力したものが断られた）。
func errPasswordRequired(reason, message string) *rpc.Error {
	e := rpc.Errorf(rpc.CodePasswordRequired, "%s", message)
	e.Data, _ = json.Marshal(map[string]any{"reason": reason})
	return e
}

// dbQueryError は db.Open・Session.Query の間違いを、窓への返事にする。
//   - 入力したパスワードを DB が断った：password_required（reason は "rejected"）。窓は聞き直す。
//   - それ以外：db_error。data は {kind, sqlState?, passwordSource?}。kind は db.ErrorKind。
//     passwordSource は kind が "auth" のときだけで、断られたパスワードを見つけた場所（"keychain" か "file"）。
//     これは聞き直しても直らない（見つけた場所のものが先に使われる）ので、利用者がその場所を直す。
func dbQueryError(ctx context.Context, err error, src db.Source) *rpc.Error {
	e, ok := errors.AsType[*db.Error](err)
	if !ok {
		return rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	// ログインの途中で取り消されたものも、取り消しとして返す。
	e = db.Cancelled(ctx, e)
	data := map[string]any{"kind": e.Kind}
	switch {
	case e.Kind == db.KindAuth && src.Typed():
		return errPasswordRequired("rejected", e.Message)
	case e.Kind == db.KindAuth:
		data["passwordSource"] = src
	}
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
