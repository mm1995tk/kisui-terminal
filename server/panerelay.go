package server

// kisui pane の --machine（欄の中のコマンド。#344）。別のマシンのペインへの頼みを、手元の GUI に中継させる。
// 設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// serve はマシンごとに 1 つで、自分のマシンのペインしか知らない。GUI は全部のマシンの serve につながっている。
// だから頼まれた serve は、確かめられることを確かめてから pane.relay {id, machine, request} を GUI（owner）に通知し、
// GUI の pane.relayed {id, reply} を待つ。GUI は machine（[[gui.machines]] の名前。local は GUI の動く手元の PC）の serve に
// pane.run {request} を送り（open-tab は、kisui pane open と同じく GUI がそのマシンにタブを作る）、その返事を reply にして答える。
// 頼んだペインの秘密は、頼まれた serve が確かめる（paneCmd）。相手のマシンの serve は、owner の GUI の pane.run を
// ほかの GUI の頼み（term.input など）と同じく受ける。serve は確認を出さない（何をするかはコマンドの引数に出ている）。
// ssh 先のマシンから手元の PC への頼みは、GUI が、窓の前の人が時間を決めて許している間だけ通し、ペインを作る頼みを人に聞く。
// だから、頼んだ serve は答えを長く待ち（paneRelayWait）、待つのをやめたら pane.relayCancel で取り下げを知らせる。
// 中継してよいかは GUI が決める：手元の PC の serve の頼みはどのマシンにも、ssh 先の serve の頼みは、手元の設定
// （そのマシンの [[gui.machines]] の allow_pane_to）で許した先にだけ中継する。許していなければ、理由を reply の error で返す。

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapPaneRelayWait は capabilities に入れる、pane.relay の答えを人が決めるまで（paneRelayWait）待ち、待つのをやめたら
// pane.relayCancel {id} を通知する印。GUI は、この印のある serve の頼みにだけ、人に聞く窓を出す（古い serve は 8 秒で
// あきらめ、やめたことも知らせないので、聞いている間に時間切れになる）。
const CapPaneRelayWait = "pane.relay.wait"

// paneRelayWait は、kisui pane の --machine が GUI の答えを待つ時間。手元の PC への頼みは、窓の前の人が許すかを答えるまで
// 待つことがある。コーディングエージェントがコマンドを待つ時間（2 分のものが多い）より短くして、時間切れを理由と一緒に
// 返せるようにする（kisui db propose の dbProposeWait と同じ考え）。人に聞かない頼みは、GUI が 8 秒であきらめて答える。
// 変数なのは、テストで短くするため。
var paneRelayWait = 90 * time.Second

// CapPaneRun は session.hello の capabilities に入れる、pane.run（別のマシンから中継した kisui pane の頼み）を受けられる印。
// GUI はこれを見てから送る（古い serve には送らずに断る）。
const CapPaneRun = "pane.run"

// paneRelayResult は GUI の pane.relayed の中身。
type paneRelayResult struct {
	Reply panecmd.Reply `json:"reply"`
}

// paneRunRequest は pane.relay で GUI に渡し、GUI が相手のマシンに pane.run で送る頼み（panecmd.Request から、
// 頼んだペインの id・秘密・マシンを除いたもの）。
type paneRunRequest struct {
	Cmd       string   `json:"cmd"`
	To        string   `json:"to,omitempty"`
	Text      string   `json:"text,omitempty"`
	Keys      []string `json:"keys,omitempty"`
	Lines     int      `json:"lines,omitempty"`
	Workspace string   `json:"workspace,omitempty"`
	New       bool     `json:"new,omitempty"`
	Name      string   `json:"name,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	Argv      []string `json:"argv,omitempty"`
}

var (
	errRelayTimeout  = errors.New("the window did not answer in time (the request may still be done on that machine)")
	errNoMachineName = errors.New("the name of the machine is empty")
)

// paneRelayStart は、ペイン t の --machine の付いた rq を GUI に中継させ、答えを待つ paneCmdLater を返す（待つのは呼ぶ側）。
// GUI には、頼んだペインの id（pane）と、open-tab なら作るタブに持たせる系譜（ancestry）も渡す。相手のマシンの serve は、
// それで届く範囲を決める（panereach.go）。どのマシンのペインかは、GUI がこの接続の serverId から決める（ここで言う値は信じない）。
func (s *Server) paneRelayStart(t *terminal, rq panecmd.Request) (panecmd.Reply, error) {
	machine := strings.TrimSpace(rq.Machine)
	if machine == "" {
		return panecmd.Reply{}, errNoMachineName
	}
	out := paneRunRequest{Cmd: rq.Cmd, To: rq.To, Text: rq.Text, Keys: rq.Keys, Lines: rq.Lines}
	switch rq.Cmd {
	case "list", "send", "keys", "close", "read":
	case "open-tab":
		ws, name, err := relayOpenNames(rq)
		if err != nil {
			return panecmd.Reply{}, err
		}
		// コマンドとフォルダは相手のマシンのもの。ここでは探せないので、絶対パスで書いてもらう
		if _, err := validCommand(rq.Argv, rq.Env); err != nil {
			return panecmd.Reply{}, err
		}
		if rq.Cwd != "" && !filepath.IsAbs(rq.Cwd) {
			return panecmd.Reply{}, fmt.Errorf("not an absolute path: %s", rq.Cwd)
		}
		out = paneRunRequest{Cmd: rq.Cmd, Workspace: ws, New: rq.New, Name: name, Cwd: rq.Cwd, Argv: rq.Argv}
	default:
		return panecmd.Reply{}, fmt.Errorf("%q does not take a machine", rq.Cmd)
	}
	params := map[string]any{"machine": machine, "request": out, "pane": t.id}
	if rq.Cmd == "open-tab" {
		params["ancestry"] = s.lineage(t)
	}
	// 待つのをやめたら（時間切れ・頼んだコマンドが切れた）、GUI に取り下げを知らせる（人に聞いている窓を閉じさせる）
	withdraw := func(id string) { s.notifyOwner("pane.relayCancel", map[string]any{"id": id}) }
	return askWindowWithin(s, &s.relays, "pane.relay", params, paneRelayWait, errRelayTimeout, withdraw, func(r paneRelayResult) (panecmd.Reply, error) {
		if r.Reply.Error != "" {
			return panecmd.Reply{}, errors.New(r.Reply.Error)
		}
		r.Reply.Code = ""
		return r.Reply, nil
	})
}

// relayOpenNames は、別のマシンに開く kisui pane open のワークスペースの名前とペインの名前を確かめる（paneOpenStart と同じ決まり。
// 名前の重なりは、相手のマシンの serve がタブを作るときに確かめる）。
func relayOpenNames(rq panecmd.Request) (ws, name string, err error) {
	if ws, err = cleanPaneName(rq.Workspace); err != nil {
		return "", "", fmt.Errorf("the name of the workspace: %w", err)
	}
	if ws == "" {
		return "", "", errNoWorkspaceName
	}
	if name, err = cleanPaneName(rq.Name); err != nil {
		return "", "", err
	}
	if name == "" {
		return "", "", errNoPaneName
	}
	return ws, name, nil
}

// paneRelayedNotify は GUI の pane.relayed。いまの GUI（owner）のものだけを受ける。
func (ss *session) paneRelayedNotify(params json.RawMessage) {
	if ss.isSuperseded() || ss.needHello() != nil {
		return
	}
	var p struct {
		ID string `json:"id"`
		paneRelayResult
	}
	if json.Unmarshal(params, &p) != nil || p.ID == "" {
		return
	}
	ss.srv.relays.deliver(p.ID, p.paneRelayResult)
}

// paneRunReq は GUI の pane.run：別のマシンのペインから中継された頼み（read・list・send・keys・close）を、このマシンで行う。
// 届くのは、頼んだペイン（from）が作ったペインの先だけ（panereach.go）。
// 断るとき（ペインが無いなど）も、返事の error に理由を入れて返す（GUI はそのまま頼んだマシンに渡す）。
func (ss *session) paneRunReq(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var p struct {
		panecmd.Request
		// From は、頼んだペイン（別のマシンのペイン。GUI が、頼みを送ってきた serve の serverId を付ける）。
		// 無ければ（古い GUI）、だれが作ったペインにも届かない
		From paneOrigin `json:"from"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
	}
	rq := p.Request
	r, err, ok := ss.srv.paneOther(rq, p.From, "")
	if !ok {
		err = fmt.Errorf("%q cannot be done from another machine", rq.Cmd)
	}
	if err != nil {
		r = panecmd.Reply{Error: err.Error()}
	}
	r.OK = r.Error == ""
	return r, nil
}
