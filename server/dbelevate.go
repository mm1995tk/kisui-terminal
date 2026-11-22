package server

// DB の権限を、時間を決めて一時的に強める（#383）。普段は弱い権限（本番では読むだけ、など）で使い、要るときだけ
// 人が時間を決めて強める。時間が過ぎたら、何もしなくても元の権限に戻る。
//
// 作り：
//   - 強めてよいかは設定が決める：権限（[db.permissions.<名前>]）の elevate-to（強めた間に使う権限）と
//     elevate-max（一度に強められる時間の上限）。2 つを書いていない権限は強められない（config/dbperm.go）。
//   - 強めた状態（どの接続の変種の、誰の権限を、いつまで）は、ここ（dbManager.elevations）のメモリだけに持つ。
//     ファイルにも、kisui serve の引き継ぎにも渡さない：kisui serve が止まる・引き継がれると、元の権限に戻る。
//   - 権限の判定は今までどおり 1 か所（dbManager.access → config.DBConnection.Access）。強めている間は、その前に
//     接続の権限を強めた先に差し替える（config.DBConnection.Elevated）だけなので、read-only = true の接続は、
//     強めても「読むだけ」を超えない。
//   - 強める・戻すを頼めるのは、窓（GUI の接続）の db.elevate と db.elevateEnd だけ。ペインの中のコマンド
//     （kisui db。dbcmd.go）には無いので、コーディングエージェントは自分では強められない。
//   - 時間が過ぎたときに動いている SQL は、取り消さずに終わるまで待つ：権限は文を始めるときに確かめ、1 つの文は
//     1 つのログインで、途中で止めても文は丸ごと取り消されるだけなので。時間が過ぎた後に始める文から、元の権限になる。

import (
	"encoding/json"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapDBElevate は capabilities に入れる、db.elevate と db.elevateEnd（権限を時間を決めて強める・戻す。#383）を受けられる印。
const CapDBElevate = "db-elevate"

// dbElevKey は、強めた状態の持ち方：接続の変種ごと、誰の権限かごと（shop (prod) を強めても shop (dev) は変わらない）。
type dbElevKey struct {
	name, variant string
	actor         config.DBActor
}

// dbElevation は、強めた状態の 1 つ。
type dbElevation struct {
	// from は、強めたときの元の権限の名前。target は、強めた先の権限（名前だけでなく、run・agent-user などの中身も）。
	// 設定が書き換わって、元の権限が違う名前になったら、または強めた先が名前か中身の違うものになったら、強めた状態を
	// 捨てる（人が見て許したのと違う権限を、強めたことにしない）。
	from   string
	target config.DBPermission
	// start は強めた時刻、until は元に戻る時刻。
	start, until time.Time
}

// DBElevate は、ある権限を強められること（db.connections の human.elevate・agent.elevate）。
type DBElevate struct {
	// To は、強めた間に使う権限の名前（設定の elevate-to）。
	To string `json:"to"`
	// Run は、強めた間の実行の段階（read-only = true の接続では、To が "free" でも "read"）。
	Run config.DBRun `json:"run"`
	// MaxSeconds は、一度に強められる時間の上限（設定の elevate-max。秒）。
	MaxSeconds int64 `json:"maxSeconds"`
}

// DBElevated は、ある権限を今強めていること（db.connections の human.elevated・agent.elevated）。
type DBElevated struct {
	// From は、元の権限の名前（時間が過ぎると、これに戻る）。
	From string `json:"from"`
	// Until は元に戻る時刻（kisui serve のマシンの時計）。
	Until time.Time `json:"until"`
	// RemainingSeconds は、答えたときの残りの時間（秒。切り上げ）。窓は、マシンの時計のずれに関わらず、これで残りを数える。
	RemainingSeconds int64 `json:"remainingSeconds"`
}

// elevation は、c の actor の権限を今強めているなら、その状態。時間が過ぎたもの・設定が変わって合わなくなったものは、
// ここで捨てる（時計で消すのではなく、聞かれたときに確かめる）。合うかどうかは、元の権限は名前で、強めた先は中身まで見る。設定の elevate-max が強めた後に短く書き換わったら、
// 強めた時刻から数えた新しい上限までで終える。
func (m *dbManager) elevation(c config.DBConnection, actor config.DBActor) (dbElevation, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := dbElevKey{c.Name, c.Variant, actor}
	e, ok := m.elevations[k]
	if !ok {
		return dbElevation{}, false
	}
	perm := c.Permission(actor)
	target, can := c.ElevateTarget(actor)
	if !can || perm.Name != e.from || target != e.target {
		delete(m.elevations, k)
		return dbElevation{}, false
	}
	if limit := e.start.Add(perm.ElevateMax); limit.Before(e.until) {
		e.until = limit
	}
	if !m.now().Before(e.until) {
		delete(m.elevations, k)
		return dbElevation{}, false
	}
	return e, true
}

// elevated は、c の actor の権限を今強めているなら、権限を強めた先に差し替えた c。強めていなければ c のまま。
func (m *dbManager) elevated(c config.DBConnection, actor config.DBActor) config.DBConnection {
	if _, ok := m.elevation(c, actor); ok {
		c, _ = c.Elevated(actor)
	}
	return c
}

// elevateInfo は、db.connections に入れる、c の actor の権限の「強められること」と「今強めていること」（無ければ nil）。
func (m *dbManager) elevateInfo(c config.DBConnection, actor config.DBActor) (can *DBElevate, on *DBElevated) {
	if target, ok := c.ElevateTarget(actor); ok {
		ec, _ := c.Elevated(actor)
		can = &DBElevate{To: target.Name, Run: ec.Access(actor).Run, MaxSeconds: int64(c.Permission(actor).ElevateMax / time.Second)}
	}
	if e, ok := m.elevation(c, actor); ok {
		left := e.until.Sub(m.now())
		on = &DBElevated{From: e.from, Until: e.until, RemainingSeconds: int64((left + time.Second - 1) / time.Second)}
	}
	return can, on
}

// dbElevateParams は db.elevate と db.elevateEnd の引数。
type dbElevateParams struct {
	Connection string `json:"connection"`
	Variant    string `json:"variant"`
	// Actor は、誰の権限を強めるか（"human" か "agent"）。頼んでいるのは、どちらでも人（窓）。省けない。
	Actor string `json:"actor"`
	// Duration は強める時間（"30m"・"1h"・"1h30m"。config.ParseDBDuration の書き方）。db.elevateEnd では読まない。
	Duration string `json:"duration"`
}

// DBElevateResult は db.elevate と db.elevateEnd の結果：変えた後の、その接続（db.connections の 1 つと同じ形）。
type DBElevateResult struct {
	Connection DBConnectionInfo `json:"connection"`
}

// errDBElevateDenied は、強められないときの denied。reason は "not_elevatable"（その権限は強められない）か
// "over_max"（時間が上限を超える。maxSeconds に上限）。
func errDBElevateDenied(reason string, maxSeconds int64, format string, args ...any) *rpc.Error {
	e := rpc.Errorf(rpc.CodeDenied, format, args...)
	data := map[string]any{"reason": reason}
	if maxSeconds > 0 {
		data["maxSeconds"] = maxSeconds
	}
	e.Data, _ = json.Marshal(data)
	return e
}

// dbElevateTarget は db.elevate と db.elevateEnd の引数から、接続と、誰の権限かを読む。
func (s *Server) dbElevateTarget(req *rpc.Message) (p dbElevateParams, c config.DBConnection, actor config.DBActor, err error) {
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return p, c, "", invalidParams(err)
	}
	if p.Actor == "" {
		return p, c, "", rpc.Errorf(rpc.CodeInvalidParams, "actor is required: whose permission, %q or %q", config.DBHuman, config.DBAgent)
	}
	if actor, err = dbActor(p.Actor); err != nil {
		return p, c, "", err
	}
	c, err = s.db.find(p.Connection, p.Variant)
	return p, c, actor, err
}

// dbElevateReq は db.elevate：接続（の変種）の、人かコーディングエージェントの権限を、duration の間だけ強める。
// もう強めていれば、今から duration の間に決め直す（延ばす・縮める）。窓（GUI の接続）の要求だけがここに来る。
func (ss *session) dbElevateReq(req *rpc.Message) (any, error) {
	s := ss.srv
	p, c, actor, err := s.dbElevateTarget(req)
	if err != nil {
		return nil, err
	}
	d, ok := config.ParseDBDuration(p.Duration)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "duration must be written like 30m, 1h or 1h30m: %q", p.Duration)
	}
	perm := c.Permission(actor)
	target, can := c.ElevateTarget(actor)
	if !can {
		return nil, errDBElevateDenied("not_elevatable", 0, "the permission of the %s on the connection %s cannot be elevated (it has no elevate-to)", actor, c.Label())
	}
	if d > perm.ElevateMax {
		return nil, errDBElevateDenied("over_max", int64(perm.ElevateMax/time.Second), "the permission %s can be elevated for at most %s at a time", perm.Name, perm.ElevateMax)
	}
	m := s.db
	now := m.now()
	m.mu.Lock()
	// 時間の過ぎたものを、ついでに捨てる（設定から消えた接続のものが残り続けないように）。
	for k, e := range m.elevations {
		if !now.Before(e.until) {
			delete(m.elevations, k)
		}
	}
	m.elevations[dbElevKey{c.Name, c.Variant, actor}] = dbElevation{from: perm.Name, target: target, start: now, until: now.Add(d)}
	m.mu.Unlock()
	s.log.Info("db.elevate", "connection", c.Name, "variant", c.Variant, "actor", actor, "from", perm.Name, "to", target.Name, "duration", d.String())
	return DBElevateResult{Connection: s.dbConnectionInfo(c)}, nil
}

// dbElevateEndReq は db.elevateEnd：強めた権限を、時間の前に元に戻す。強めていなければ何も変えない（間違いにしない）。
func (ss *session) dbElevateEndReq(req *rpc.Message) (any, error) {
	s := ss.srv
	_, c, actor, err := s.dbElevateTarget(req)
	if err != nil {
		return nil, err
	}
	m := s.db
	k := dbElevKey{c.Name, c.Variant, actor}
	m.mu.Lock()
	_, was := m.elevations[k]
	delete(m.elevations, k)
	m.mu.Unlock()
	if was {
		s.log.Info("db.elevateEnd", "connection", c.Name, "variant", c.Variant, "actor", actor)
	}
	return DBElevateResult{Connection: s.dbConnectionInfo(c)}, nil
}
