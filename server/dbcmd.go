package server

// kisui db（ペインの中のコマンド。#382）。コーディングエージェントが、シェルから DB の接続の一覧・スキーマの一覧を読み、
// SQL を実行し、DB のタブの入力欄に SQL を書く。設計は docs/design/gui-protocol.md の「DB」の「ペインの中のコマンド」。
//
// どの頼みも、コーディングエージェントのもの（actor は "agent"）として扱う。人のものとして通す道は無い：
// Window の要求（db.*）と同じ dbWith を通り、権限の判定（dbManager.access）も同じ 1 か所。
// パスワードは受け取らない（コマンドの引数に書かせない）。どこにも無ければ、聞かずに断る。
//
// 接続は、頼んだペインのマシンの kisui serve の設定のもの（--machine は無い）。
//
// 入力欄に書く（db-propose）は、DB のタブを持つ Window に頼む：確かめられること（接続があるか・権限が許すか）を確かめてから
// db.propose {id, connection, variant?, sql} を GUI（owner）に通知し、GUI の db.proposed {id, status?, error?} を待つ。
// GUI は、今のワークスペースの、同じマシン・同じ接続（と変種）の DB のタブを探し（無ければ開き）、入力欄が空ならそのまま書く。
// SQL があれば人に聞く。人の答えを待つので、ほかの頼み（windowWait）より長く待つ。待つのをやめたら
// db.proposeCancel {id} を通知して、GUI に問いを取り下げさせる（コマンドが「書けなかった」と返したあとで、上書きされないように）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// dbProposeWait は、kisui db propose が GUI の答え（人が上書きを許すか）を待つ時間。
// コーディングエージェントがコマンドを待つ時間（2 分のものが多い）より短くして、時間切れを理由と一緒に返せるようにする。
// 変数なのは、テストで短くするため。
var dbProposeWait = 90 * time.Second

// maxProposeSQL は、入力欄に書く SQL の長さの上限（バイト）。履歴に残せる長さと同じ。
const maxProposeSQL = db.MaxHistorySQL

// dbProposeResult は GUI の db.proposed の中身。
type dbProposeResult struct {
	// Status は "written"（入力欄に書いた）か "declined"（人が上書きを断った）
	Status string `json:"status"`
	// Error は書けなかった理由（GUI が書いた文。そのまま kisui db propose が出す）
	Error string `json:"error"`
}

var errProposeTimeout = errors.New("nobody answered in the window in time, so the SQL was not written")

// isDBCmd は、rq が kisui db の頼みか。
func isDBCmd(rq panecmd.Request) bool {
	return strings.HasPrefix(rq.Cmd, "db-")
}

// dbCmd は kisui db の頼み（--machine の付いたものは、ここに来る前に paneRelayStart が断る）。DB につなぐもの・GUI の答えを待つものは、続きを paneCmdLater で返す（行うのは呼ぶ側。読みロックの外）。
func (s *Server) dbCmd(rq panecmd.Request) (panecmd.Reply, error) {
	login := dbLogin{Connection: rq.Connection, Variant: rq.Variant, Actor: string(config.DBAgent)}
	switch rq.Cmd {
	case "db-connections":
		return dbCmdReply(s.dbConnections(), nil)
	case "db-schema":
		return panecmd.Reply{}, &paneCmdLater{run: func(ctx context.Context) (panecmd.Reply, error) {
			return dbCmdReply(s.dbSchema(ctx, login))
		}}
	case "db-query":
		return panecmd.Reply{}, &paneCmdLater{run: func(ctx context.Context) (panecmd.Reply, error) {
			return dbCmdReply(s.dbQuery(ctx, dbQueryParams{dbLogin: login, SQL: rq.SQL, MaxRows: rq.MaxRows}))
		}}
	case "db-propose":
		return s.dbProposeStart(rq)
	}
	return panecmd.Reply{}, fmt.Errorf("unknown command: %q", rq.Cmd)
}

// dbCmdReply は、db.* の結果 res（か間違い err）を、コマンドへの返事にする。
func dbCmdReply(res any, err error) (panecmd.Reply, error) {
	if err != nil {
		return panecmd.Reply{}, dbCmdError(err)
	}
	b, err := json.Marshal(res)
	if err != nil {
		return panecmd.Reply{}, err
	}
	return panecmd.Reply{DB: b}, nil
}

// dbCmdError は、db.* の間違い（*rpc.Error）を、コマンドへの返事の間違いにする。文は rpc の番号を除いた中身だけにし、
// コマンドが見分けるもの（権限が許さない・パスワードが無い・接続が無い）には panecmd の Code を付ける。
func dbCmdError(err error) error {
	e, ok := errors.AsType[*rpc.Error](err)
	if !ok {
		return err
	}
	code := ""
	switch e.Code {
	case rpc.CodeDenied:
		code = panecmd.CodeDenied
	case rpc.CodePasswordRequired:
		code = panecmd.CodePasswordRequired
	case rpc.CodeNotFound:
		code = panecmd.CodeNotFound
	}
	return &paneCmdError{code: code, msg: e.Message}
}

// dbProposeStart は kisui db propose。rq.Connection（と rq.Variant）の DB のタブの入力欄に rq.SQL を書くよう GUI に頼み、
// 答えを待つ paneCmdLater を返す（待つのは呼ぶ側）。接続が設定にあるか・エージェントの権限が許すかは、GUI に頼む前にここで確かめる。
func (s *Server) dbProposeStart(rq panecmd.Request) (panecmd.Reply, error) {
	switch {
	case strings.TrimSpace(rq.SQL) == "":
		return panecmd.Reply{}, errors.New("sql is empty")
	case len(rq.SQL) > maxProposeSQL:
		return panecmd.Reply{}, fmt.Errorf("the SQL is too long (at most %d bytes)", maxProposeSQL)
	case !utf8.ValidString(rq.SQL) || strings.ContainsRune(rq.SQL, 0):
		return panecmd.Reply{}, errors.New("the SQL is not text")
	}
	conf, err := s.db.find(rq.Connection, rq.Variant)
	if err != nil {
		return panecmd.Reply{}, dbCmdError(err)
	}
	if acc := s.db.access(conf, config.DBAgent); !acc.Propose {
		return panecmd.Reply{}, &paneCmdError{code: panecmd.CodeDenied,
			msg: fmt.Sprintf("the permission of the %s does not allow writing SQL into the input of the connection %s", acc.Actor, conf.Label())}
	}
	params := map[string]any{"connection": conf.Name, "sql": rq.SQL}
	if conf.Variant != "" {
		params["variant"] = conf.Variant
	}
	withdraw := func(id string) { s.notifyOwner("db.proposeCancel", map[string]any{"id": id}) }
	return askWindowWithin(s, &s.proposes, "db.propose", params, dbProposeWait, errProposeTimeout, withdraw, func(r dbProposeResult) (panecmd.Reply, error) {
		switch {
		case r.Error != "":
			return panecmd.Reply{}, errors.New(r.Error)
		case r.Status == "written":
			return panecmd.Reply{}, nil
		case r.Status == "declined":
			return panecmd.Reply{}, &paneCmdError{code: panecmd.CodeDeclined,
				msg: "the person at the window declined to replace the SQL in the input, so the SQL was not written"}
		}
		return panecmd.Reply{}, errors.New("the window did not write the SQL")
	})
}

// dbProposedNotify は GUI の db.proposed。いまの GUI（owner）のものだけを受ける。
func (ss *session) dbProposedNotify(params json.RawMessage) {
	if ss.isSuperseded() || ss.needHello() != nil {
		return
	}
	var p struct {
		ID string `json:"id"`
		dbProposeResult
	}
	if json.Unmarshal(params, &p) != nil || p.ID == "" {
		return
	}
	ss.srv.proposes.deliver(p.ID, p.dbProposeResult)
}
