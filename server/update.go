package server

// kisui update（欄の中のコマンド。#94）。アプリに新しい版を調べ直させ、アプリの答えを kisui update に返す。
//
// serve は update.check {id} を GUI（owner）に通知し、GUI が update.result {id, status, ...} の通知で答えるのを待つ。
// 調べるのも知らせを出すのも GUI（殻の updater）で、serve は取り次ぐだけ。ssh 先の serve も同じ道で、手元の GUI が調べる。

import (
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// updateWait は update の返事を待つ時間。panecmd.Timeout より短くして、kisui update が返事を受け取れるようにする。
const updateWait = 8 * time.Second

// updateWaits は、GUI の答えを待っている kisui update（update.check の id -> 答えの口）。
type updateWaits struct {
	mu   sync.Mutex
	next int
	wait map[string]chan panecmd.UpdateResult
}

func (u *updateWaits) add() (string, chan panecmd.UpdateResult) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.wait == nil {
		u.wait = map[string]chan panecmd.UpdateResult{}
	}
	u.next++
	id := "u" + strconv.Itoa(u.next)
	ch := make(chan panecmd.UpdateResult, 1)
	u.wait[id] = ch
	return id, ch
}

func (u *updateWaits) remove(id string) {
	u.mu.Lock()
	delete(u.wait, id)
	u.mu.Unlock()
}

// deliver は id を待っている kisui update に r を渡す。待っていなければ（時間切れ・知らない id）捨てる。
func (u *updateWaits) deliver(id string, r panecmd.UpdateResult) {
	u.mu.Lock()
	ch := u.wait[id]
	delete(u.wait, id)
	u.mu.Unlock()
	if ch != nil {
		ch <- r // 容量 1 で、渡すのは 1 度だけ（取り出した時点で map から消している）
	}
}

// updateWaiting は、kisui update の頼みを GUI に送り、答えを待つだけになったことを paneCmd が知らせる値（error として返す）。
// 呼ぶ側（paneCmdConn）が読みロックを手放してから wait を呼ぶ。
type updateWaiting struct{ wait func() (panecmd.Reply, error) }

func (*updateWaiting) Error() string { return "waiting for the window" }

var (
	errNoWindow      = errors.New("the kisui-terminal window is not connected")
	errUpdateTimeout = errors.New("the window did not answer in time (the notice may still appear)")
)

// updateStart は kisui update。GUI に update.check を送り、答えを待つ updateWaiting を返す（待つのは呼ぶ側）。
func (s *Server) updateStart() (panecmd.Reply, error) {
	id, ch := s.updates.add()
	if !s.notifyOwner("update.check", map[string]any{"id": id}) {
		s.updates.remove(id)
		return panecmd.Reply{}, errNoWindow
	}
	return panecmd.Reply{}, &updateWaiting{wait: func() (panecmd.Reply, error) {
		defer s.updates.remove(id)
		select {
		case r := <-ch:
			return panecmd.Reply{Update: &r}, nil
		case <-time.After(updateWait):
			return panecmd.Reply{}, errUpdateTimeout
		}
	}}
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
