package server

// kisui update（欄の中のコマンド。#94）。アプリに新しい版を調べ直させ、アプリの答えを kisui update に返す。
//
// serve は update.check {id} を GUI（owner）に通知し、GUI が update.result {id, status, ...} の通知で答えるのを待つ。
// 調べるのも知らせを出すのも GUI（殻の updater）で、serve は取り次ぐだけ。ssh 先の serve も同じ道で、手元の GUI が調べる。
//
// GUI に頼んで答えを待つ仕組み（windowWaits・askWindow）は、kisui pane open（paneopen.go）・kisui pane の --machine（panerelay.go）・
// kisui db propose（dbcmd.go）も使う。

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// windowWait は GUI の答えを待つ時間（kisui update・kisui pane open）。panecmd.Timeout より短くして、
// 欄の中のコマンドが返事を受け取れるようにする。
const windowWait = 8 * time.Second

// windowWaits は、GUI の答えを待っている欄の中のコマンド（頼みの id -> 答えの口）。id は prefix と番号。
type windowWaits[T any] struct {
	prefix string
	mu     sync.Mutex
	next   int
	wait   map[string]chan T
}

func (u *windowWaits[T]) add() (string, chan T) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.wait == nil {
		u.wait = map[string]chan T{}
	}
	u.next++
	id := u.prefix + strconv.Itoa(u.next)
	ch := make(chan T, 1)
	u.wait[id] = ch
	return id, ch
}

func (u *windowWaits[T]) remove(id string) {
	u.mu.Lock()
	delete(u.wait, id)
	u.mu.Unlock()
}

// deliver は id を待っているコマンドに r を渡す。待っていなければ（時間切れ・知らない id）捨てる。
func (u *windowWaits[T]) deliver(id string, r T) {
	u.mu.Lock()
	ch := u.wait[id]
	delete(u.wait, id)
	u.mu.Unlock()
	if ch != nil {
		ch <- r // 容量 1 で、渡すのは 1 度だけ（取り出した時点で map から消している）
	}
}

// askWindow は GUI に method を通知し（params の "id" に待ちの id を入れる）、答えを待つ paneCmdLater を返す
// （待つのは呼ぶ側）。GUI がつながっていなければ errNoWindow。答えが windowWait のうちに来なければ timeout。
// 来た答えは reply で返事にする。
func askWindow[T any](s *Server, u *windowWaits[T], method string, params map[string]any, timeout error, reply func(T) (panecmd.Reply, error)) (panecmd.Reply, error) {
	return askWindowWithin(s, u, method, params, windowWait, timeout, nil, reply)
}

// askWindowWithin は askWindow と同じで、答えを待つ時間 wait を決められる（人の答えを待つ kisui db propose は長く待つ）。
// 答えを待つのをやめたとき（時間切れ・頼んだコマンドが切れた）は、giveUp（nil でなければ）に待ちの id を渡す：
// GUI に、その頼みを取り下げたと伝えるため。
func askWindowWithin[T any](s *Server, u *windowWaits[T], method string, params map[string]any, wait time.Duration, timeout error, giveUp func(id string), reply func(T) (panecmd.Reply, error)) (panecmd.Reply, error) {
	id, ch := u.add()
	params["id"] = id
	if !s.notifyOwner(method, params) {
		u.remove(id)
		return panecmd.Reply{}, errNoWindow
	}
	return panecmd.Reply{}, &paneCmdLater{run: func(ctx context.Context) (panecmd.Reply, error) {
		defer u.remove(id)
		select {
		case r := <-ch:
			return reply(r)
		case <-time.After(wait):
		case <-ctx.Done(): // 頼んだコマンドが切れた（返事を受け取る相手がいない）
		}
		if giveUp != nil {
			giveUp(id)
		}
		return panecmd.Reply{}, timeout
	}}
}

// paneCmdLater は、欄の中のコマンドの頼みの続き（run）を、読みロックの外で行うことを paneCmd が知らせる値（error として返す）。
// GUI に頼みを送って答えを待つもの（askWindow）と、DB につなぐもの（kisui db。dbcmd.go）が使う：どちらも長くかかることがあり、
// 読みロックを持ったままだと、その間 serve の引き継ぎ（書きロックを待つ）が止まる。
// 呼ぶ側（paneCmdConn）が読みロックを手放してから run を呼ぶ。run の ctx は、頼んだコマンドが切れると終わる。
type paneCmdLater struct {
	run func(ctx context.Context) (panecmd.Reply, error)
}

func (*paneCmdLater) Error() string { return "the rest of the request runs outside the lock" }

var (
	errNoWindow      = errors.New("the kisui-terminal window is not connected")
	errUpdateTimeout = errors.New("the window did not answer in time (the notice may still appear)")
)

// updateStart は kisui update。GUI に update.check を送り、答えを待つ paneCmdLater を返す（待つのは呼ぶ側）。
func (s *Server) updateStart() (panecmd.Reply, error) {
	return askWindow(s, &s.updates, "update.check", map[string]any{}, errUpdateTimeout, func(r panecmd.UpdateResult) (panecmd.Reply, error) {
		return panecmd.Reply{Update: &r}, nil
	})
}

// updateNotify は GUI の update.result。いまの GUI（owner）のものだけを受ける。
func (ss *session) updateNotify(params json.RawMessage) {
	if ss.isSuperseded() || ss.needHello() != nil {
		return
	}
	var p struct {
		ID string `json:"id"`
		panecmd.UpdateResult
	}
	if json.Unmarshal(params, &p) != nil || p.ID == "" {
		return
	}
	ss.srv.updates.deliver(p.ID, p.UpdateResult)
}
