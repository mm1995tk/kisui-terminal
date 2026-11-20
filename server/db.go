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
func (m *dbManager) run(ctx context.Context, c config.DBConnection, password string, src db.Source, f func(db.Session) error) error {
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
}

// dbWith は p の接続にログインして f を呼ぶ。接続を探す・動いているものに足す（db.cancel で止められる）・
// パスワードを探す・間違いを窓への返事にする、は db.query と db.schema で同じ。what はログに書く要求の名前。
func (ss *session) dbWith(ctx context.Context, p dbLogin, what string, f func(context.Context, config.DBConnection, db.Session) error) error {
	m := ss.srv.db
	c, err := m.find(p.Connection, p.Variant)
	if err != nil {
		return err
	}
	ctx, done, err := m.begin(ctx, p.QueryID)
	if err != nil {
		return err
	}
	defer done()
	password, src, err := m.passwords.Find(ctx, c, p.Password)
	if err != nil {
		return errPasswordRequired("missing", "a password is required for the connection "+c.Label())
	}
	err = m.run(ctx, c, password, src, func(s db.Session) error { return f(ctx, c, s) })
	if err != nil {
		// SQL とパスワードはログに書かない。
		ss.srv.log.Info(what+" failed", "connection", c.Name, "variant", c.Variant)
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
	ReadOnly bool   `json:"readOnly"`
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
		res.Connections[i] = DBConnectionInfo{Name: c.Name, Variant: c.Variant, Kind: c.Kind, Host: c.Host, Port: c.Port, User: c.User, Database: c.Database, ReadOnly: c.ReadOnly}
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
	var res *db.Result
	err := ss.dbWith(ctx, p.dbLogin, "db.query", func(ctx context.Context, c config.DBConnection, s db.Session) error {
		// 履歴に足すのは、ログインが通って SQL を DB に送ったものだけ。ログインできなかった SQL は実行していないうえ、
		// password_required のあとに窓が送り直すと同じ SQL が 2 つ残ってしまう。ページを切り替えるための実行（offset あり）も
		// 残さない：同じ SQL の続きを読むだけで、ページを送るたびに同じ SQL が並んでしまう。
		at := ss.srv.now()
		var err error
		res, err = s.Query(ctx, p.SQL, db.QueryOptions{MaxRows: p.MaxRows, Offset: p.Offset})
		if p.Offset > 0 {
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
	err := ss.dbWith(ctx, p, "db.schema", func(ctx context.Context, c config.DBConnection, s db.Session) error {
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
