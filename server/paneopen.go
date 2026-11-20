package server

// kisui pane open（欄の中のコマンド。#343）。GUI のワークスペースに、コマンドを動かすターミナルのタブを足す。
// 設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// GUI のワークスペースは手元の GUI が持ち、serve は知らない（serve の「ワークスペース」は、GUI ではターミナルのタブ 1 つ）。
// だから serve は、確かめられることを確かめてから pane.open {id, workspace, new, name, dir, argv, env} を GUI（owner）に通知し、
// GUI の pane.opened {id, termId?, error?} を待つ。GUI はワークスペースを名前で探し（--new なら作り）、タブを作るマシンの serve に
// workspace.create {dir, argv, env, name} を送って、できたタブをそのワークスペースの最後に入れる（フォーカスは移さない）。
// タブを作るマシンは今は頼んだ serve 自身。GUI の側で相手のマシンを選んでいるので、別のマシンに開く（--machine。#344）ときは、
// GUI が送る相手を変えればよい。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// CapCreateCommand は session.hello の capabilities に入れる、workspace.create の argv・env・name（kisui pane open）を
// 受けられる印。古い serve は知らずに無視してシェルを始めるので、GUI はこれを見てから送る。
const CapCreateCommand = "workspace.create.command"

// paneOpenResult は GUI の pane.opened の中身。
type paneOpenResult struct {
	// TermID は作ったタブのプライマリターミナル（作れたとき）
	TermID string `json:"termId"`
	// Error は作れなかった理由（GUI が書いた文。そのまま kisui pane open が出す）
	Error string `json:"error"`
}

var (
	errOpenTimeout     = errors.New("the window did not answer in time (the tab may still open)")
	errNoWorkspaceName = errors.New("the name of the workspace is empty")
	errNoPaneName      = errors.New("the name of the pane is empty")
)

// paneOpenStart は kisui pane open。頼んだペイン t から、rq.Workspace の名前の GUI のワークスペースに、rq.Argv（空ならシェル）を
// rq.Cwd で動かすタブを足すよう GUI に頼み、答えを待つ paneCmdLater を返す（待つのは呼ぶ側）。
// 名前・コマンド・フォルダは、GUI に頼む前にここで確かめる（作るときに serve がもう一度確かめる）。
func (s *Server) paneOpenStart(t *terminal, rq panecmd.Request) (panecmd.Reply, error) {
	// ワークスペースの名前の決まりは、ペインの名前と同じ（wsManager.rename と同じく cleanPaneName で確かめる）
	ws, err := cleanPaneName(rq.Workspace)
	if err != nil {
		return panecmd.Reply{}, fmt.Errorf("the name of the workspace: %w", err)
	}
	if ws == "" {
		return panecmd.Reply{}, errNoWorkspaceName
	}
	env, err := validCommand(rq.Argv, rq.Env)
	if err != nil {
		return panecmd.Reply{}, err
	}
	name, err := cleanPaneName(rq.Name)
	if err != nil {
		return panecmd.Reply{}, err
	}
	if name == "" {
		return panecmd.Reply{}, errNoPaneName
	}
	s.terms.nameMu.Lock()
	err = s.terms.checkNameLocked(name, "")
	s.terms.nameMu.Unlock()
	if err != nil {
		return panecmd.Reply{}, err
	}
	dir := rq.Cwd
	if dir != "" {
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() || !filepath.IsAbs(dir) {
			return panecmd.Reply{}, fmt.Errorf("not a folder: %s", dir)
		}
	} else {
		t.mu.Lock()
		dir = t.cwd
		t.mu.Unlock()
	}
	params := map[string]any{"workspace": ws, "name": name, "dir": dir}
	if rq.New {
		params["new"] = true
	}
	if len(rq.Argv) > 0 {
		params["argv"] = rq.Argv
	}
	if len(env) > 0 {
		params["env"] = env
	}
	return askWindow(s, &s.opens, "pane.open", params, errOpenTimeout, func(r paneOpenResult) (panecmd.Reply, error) {
		if r.Error != "" || r.TermID == "" {
			msg := r.Error
			if msg == "" {
				msg = "the window did not open the tab"
			}
			return panecmd.Reply{}, errors.New(msg)
		}
		return panecmd.Reply{ID: r.TermID}, nil
	})
}

// paneOpenedNotify は GUI の pane.opened。いまの GUI（owner）のものだけを受ける。
func (ss *session) paneOpenedNotify(params json.RawMessage) {
	if ss.isSuperseded() || ss.needHello() != nil {
		return
	}
	var p struct {
		ID string `json:"id"`
		paneOpenResult
	}
	if json.Unmarshal(params, &p) != nil || p.ID == "" {
		return
	}
	ss.srv.opens.deliver(p.ID, p.paneOpenResult)
}
