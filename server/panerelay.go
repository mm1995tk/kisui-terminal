package server

// kisui pane の --machine（欄の中のコマンド。#344）。別のマシンのペインへの頼みを、手元の GUI に中継させる。
// 設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// serve はマシンごとに 1 つで、自分のマシンのペインしか知らない。GUI は全部のマシンの serve につながっている。
// だから頼まれた serve は、確かめられることを確かめてから pane.relay {id, machine, request} を GUI（owner）に通知し、
// GUI の pane.relayed {id, reply} を待つ。GUI は machine（[[gui.machines]] の名前。local は GUI の動く手元の PC）の serve に
// pane.run {request} を送り（open-tab は、kisui pane open と同じく GUI がそのマシンにタブを作る）、その返事を reply にして答える。
// 頼んだペインの秘密は、頼まれた serve が確かめる（paneCmd）。相手のマシンの serve は、owner の GUI の pane.run を
// ほかの GUI の頼み（term.input など）と同じく受ける。kisui-terminal は確認を出さない（何をするかはコマンドの引数に出ている）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

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

// paneRelayStart は --machine の付いた rq を GUI に中継させ、答えを待つ paneCmdLater を返す（待つのは呼ぶ側）。
func (s *Server) paneRelayStart(rq panecmd.Request) (panecmd.Reply, error) {
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
	params := map[string]any{"machine": machine, "request": out}
	return askWindow(s, &s.relays, "pane.relay", params, errRelayTimeout, func(r paneRelayResult) (panecmd.Reply, error) {
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
// 断るとき（ペインが無いなど）も、返事の error に理由を入れて返す（GUI はそのまま頼んだマシンに渡す）。
func (ss *session) paneRunReq(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var rq panecmd.Request
	if err := json.Unmarshal(req.Params, &rq); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
	}
	r, err, ok := ss.srv.paneOther(rq, "")
	if !ok {
		err = fmt.Errorf("%q cannot be done from another machine", rq.Cmd)
	}
	if err != nil {
		r = panecmd.Reply{Error: err.Error()}
	}
	r.OK = r.Error == ""
	return r, nil
}
