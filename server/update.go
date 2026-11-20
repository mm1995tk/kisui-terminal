package server

// kisui update（欄の中のコマンド。#94）。アプリに新しい版を調べ直させ、アプリの答えを kisui update に返す。
//
// serve は update.check {id} を GUI（owner）に通知し、GUI が update.result {id, status, ...} の通知で答えるのを待つ。
// 調べるのも知らせを出すのも GUI（殻の updater）で、serve は取り次ぐだけ。ssh 先の serve も同じ道で、手元の GUI が調べる。
//
// GUI に頼んで答えを待つ仕組み（windowWaits・askWindow）は、kisui pane open（paneopen.go）も使う。

import (
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

// askWindow は GUI に method を通知し（params の "id" に待ちの id を入れる）、答えを待つ windowWaiting を返す
// （待つのは呼ぶ側）。GUI がつながっていなければ errNoWindow。答えが windowWait のうちに来なければ timeout。
// 来た答えは reply で返事にする。
func askWindow[T any](s *Server, u *windowWaits[T], method string, params map[string]any, timeout error, reply func(T) (panecmd.Reply, error)) (panecmd.Reply, error) {
	id, ch := u.add()
	params["id"] = id
	if !s.notifyOwner(method, params) {
		u.remove(id)
		return panecmd.Reply{}, errNoWindow
	}
	return panecmd.Reply{}, &windowWaiting{wait: func() (panecmd.Reply, error) {
		defer u.remove(id)
		select {
		case r := <-ch:
			return reply(r)
		case <-time.After(windowWait):
			return panecmd.Reply{}, timeout
		}
	}}
}

// windowWaiting は、欄の中のコマンドの頼みを GUI に送り、答えを待つだけになったことを paneCmd が知らせる値（error として返す）。
// 呼ぶ側（paneCmdConn）が読みロックを手放してから wait を呼ぶ。
type windowWaiting struct{ wait func() (panecmd.Reply, error) }

func (*windowWaiting) Error() string { return "waiting for the window" }

var (
	errNoWindow      = errors.New("the kisui-terminal window is not connected")
	errUpdateTimeout = errors.New("the window did not answer in time (the notice may still appear)")
)

// updateStart は kisui update。GUI に update.check を送り、答えを待つ windowWaiting を返す（待つのは呼ぶ側）。
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
