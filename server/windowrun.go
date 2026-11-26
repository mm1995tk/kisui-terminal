package server

// Window に頼む、Pane の中のコマンド（kisui tab など。#511）。設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// Workspace・Tab・フォーカス・表示は Window が持ち、serve は知らない。だから serve は、Window が持つものへの頼みを中身を
// 見ずに取り次ぐ：頼んだ Pane の秘密を確かめ（paneCmd）、window.run {id, pane, tab, command, args} を Window（owner）に通知し、
// Window の window.ran {id, result?, error?, code?} を待って、result をそのままコマンドに返す。command は、行うことの名前
// （Command の id と同じ形。"tab.rename" など）、args はその引数（JSON のオブジェクト）。何ができるか・その頼みを通してよいかは
// Window が決める：window.run は頼んだ Machine の serve が作る通知なので、Window は、通知を送ってきた serve の Machine と手元の設定だけで
// 届く範囲を決める（app/src/features/sessions/windowReach.ts）。CLI を足すときは、serve は変えずに、コマンドと Window の受け口を足す。
//
// Window は session.hello の capabilities に "window.run" を入れて、受けられることを知らせる。入れていない古い Window には送らずに断る。
// 待つのは windowWait まで。頼みの long が true なら（Window が人に聞くことがある頼み）windowRunLongWait まで。待つのをやめたら
// （時間切れ・頼んだコマンドが切れた）、window.runCancel {id} で取り下げを知らせる。

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// CapWindowRun は、Window が session.hello の capabilities に入れる、window.run を受けられる印。
const CapWindowRun = "window.run"

// windowRunLongWait は、long の付いた頼み（Window が人に聞くことがある）が Window の答えを待つ時間。考え方は paneRelayWait と同じ。
// 変数なのは、テストで短くするため。
var windowRunLongWait = 90 * time.Second

// maxWindowArgs は window.run の args の大きさの上限（バイト）。
const maxWindowArgs = 256 << 10

// windowCommandName は command の形（Command の id と同じ："tab.rename"・"browser.copyUrl"）。
var windowCommandName = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$`)

// windowReplyCode は、Window が答えに付けてよい code の形。
var windowReplyCode = regexp.MustCompile(`^[a-z][a-z-]{0,31}$`)

// windowRunResult は Window の window.ran の中身。
type windowRunResult struct {
	// Result は、行った結果（JSON。そのままコマンドに返す）
	Result json.RawMessage `json:"result"`
	// Error は、行えなかった理由（Window が書いた文。そのままコマンドが出す）
	Error string `json:"error"`
	// Code は、コマンドが見分ける断り（panecmd.Reply.Code）
	Code string `json:"code"`
}

var (
	errWindowRunTimeout = errors.New("the window did not answer in time (the request may still be done)")
	errWindowTooOld     = errors.New("the kisui-terminal window is older than this kisui and cannot do this (update kisui-terminal)")
	errWindowCommand    = errors.New("the name of the command for the window is not valid")
	errWindowArgs       = errors.New("the arguments for the window are not a JSON object")
	errWindowArgsSize   = errors.New("the arguments for the window are too long")
)

// ownerCapabilities は、いまの Window（owner）が session.hello で知らせた capabilities。つながっていなければ ok は false。
func (s *Server) ownerCapabilities() (caps []string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.owner == nil {
		return nil, false
	}
	return s.owner.capabilities, true
}

// windowRunStart は、Pane t（その Terminal tab は wsID）の頼み rq（cmd は "window"）を Window に取り次ぎ、答えを待つ paneCmdLater を返す
// （待つのは呼ぶ側）。
func (s *Server) windowRunStart(t *terminal, wsID string, rq panecmd.Request) (panecmd.Reply, error) {
	if len(rq.Command) > 64 || !windowCommandName.MatchString(rq.Command) {
		return panecmd.Reply{}, errWindowCommand
	}
	args := bytes.TrimSpace(rq.Args)
	switch {
	case len(args) == 0:
		args = []byte("{}")
	case len(args) > maxWindowArgs:
		return panecmd.Reply{}, errWindowArgsSize
	case args[0] != '{' || !json.Valid(args):
		return panecmd.Reply{}, errWindowArgs
	}
	caps, ok := s.ownerCapabilities()
	if !ok {
		return panecmd.Reply{}, &paneCmdError{code: panecmd.CodeNoWindow, msg: errNoWindow.Error()}
	}
	if !slices.Contains(caps, CapWindowRun) {
		return panecmd.Reply{}, errWindowTooOld
	}
	wait := windowWait
	if rq.Long {
		wait = windowRunLongWait
	}
	params := map[string]any{"pane": t.id, "tab": wsID, "command": rq.Command, "args": json.RawMessage(args)}
	withdraw := func(id string) { s.notifyOwner("window.runCancel", map[string]any{"id": id}) }
	r, err := askWindowWithin(s, &s.windowRuns, "window.run", params, wait, errWindowRunTimeout, withdraw, func(r windowRunResult) (panecmd.Reply, error) {
		if r.Error != "" {
			// not-in-pane は serve だけが付ける（コマンドは「Pane の中でない」と読む）
			if r.Code != "" && r.Code != panecmd.CodeNotInPane && windowReplyCode.MatchString(r.Code) {
				return panecmd.Reply{}, &paneCmdError{code: r.Code, msg: r.Error}
			}
			return panecmd.Reply{}, errors.New(r.Error)
		}
		if len(r.Result) > 0 && !json.Valid(r.Result) {
			return panecmd.Reply{}, errors.New("the window answered with something that is not JSON")
		}
		return panecmd.Reply{Result: r.Result}, nil
	})
	if errors.Is(err, errNoWindow) { // 確かめたあとに Window が切れた
		return r, &paneCmdError{code: panecmd.CodeNoWindow, msg: errNoWindow.Error()}
	}
	return r, err
}

// windowRanNotify は Window の window.ran。いまの Window（owner）のものだけを受ける。
func (ss *session) windowRanNotify(params json.RawMessage) {
	if ss.isSuperseded() || ss.needHello() != nil {
		return
	}
	var p struct {
		ID string `json:"id"`
		windowRunResult
	}
	if json.Unmarshal(params, &p) != nil || p.ID == "" {
		return
	}
	ss.srv.windowRuns.deliver(p.ID, p.windowRunResult)
}
