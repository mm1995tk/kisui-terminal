package server

// 窓のワークスペース（#502）。設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// サイドバーのワークスペースは窓（GUI）が持ち、serve は知らない（serve の「ワークスペース」は、窓ではターミナルのタブ 1 つ）。
// kisui pane list に、ペインがどのワークスペースにあるかを出せるように、窓は gws.set {tabs: [{workspaceId, id, name}]} で、
// このマシンのタブそれぞれが入っているワークスペースの id と名前（サイドバーに出ている名前）を知らせる。知らせは、いつも
// このマシンの全部のタブの分で、serve は前に覚えていた対応を丸ごと置き換える（載っていないタブの対応は消す。差分を
// 送らないので、取りこぼしても次の知らせで直る）。覚えた対応は、ワークスペースの保存（workspaces.json）と引き継ぎに
// 載せるので、窓が閉じていても、serve を起動し直しても、kisui pane list は最後に知らされたものを出す。
// タブを閉じれば、その対応も消える。

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

// CapGwsSet は session.hello の capabilities に入れる、gws.set を受けられる印。窓はこれを見てから送る（古い serve には送らない）。
const CapGwsSet = "gws.set"

// gwsRef は窓のワークスペース 1 つ（id と、サイドバーに出ている名前）。知らされていなければ空。
type gwsRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var errNoGwsID = errors.New("the id of the workspace of the window is empty")

// cleanGwsRef は、窓が知らせた（または保存していた）窓のワークスペースを確かめる。id は、空・長すぎる・制御文字があるなら断る
// （cleanPaneName）。名前は、長すぎれば断り、制御文字は空白に替える：名前の決まりは窓が持ち、窓の決まりは serve の
// unicode.IsControl より狭い（C1 の制御文字を通す）ので、ここで断ると、その名前が 1 つあるだけで、このマシンの知らせが
// 丸ごと通らなくなる。
func cleanGwsRef(g gwsRef) (gwsRef, error) {
	id, err := cleanPaneName(g.ID)
	if err != nil {
		return gwsRef{}, err
	}
	if id == "" {
		return gwsRef{}, errNoGwsID
	}
	name, err := cleanPaneName(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, g.Name))
	if err != nil {
		return gwsRef{}, err
	}
	return gwsRef{ID: id, Name: name}, nil
}

// gwsSetReq は窓の gws.set。いまの窓（owner）のものだけを受ける（superseded は handle が先に断る）。
func (ss *session) gwsSetReq(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var p struct {
		Tabs []struct {
			WorkspaceID string `json:"workspaceId"`
			gwsRef
		} `json:"tabs"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
	}
	tabs := make(map[string]gwsRef, len(p.Tabs))
	for _, x := range p.Tabs {
		if x.WorkspaceID == "" {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "a tab has no workspaceId")
		}
		g, err := cleanGwsRef(x.gwsRef)
		if err != nil {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid tab %q: %v", x.WorkspaceID, err)
		}
		tabs[x.WorkspaceID] = g
	}
	ss.srv.ws.setGws(tabs)
	return struct{}{}, nil
}

// setGws は、タブ（この serve のワークスペースの id）ごとの窓のワークスペースを tabs に置き換え、変わっていれば保存する。
// tabs に無いタブの対応は消す。もう無いタブの分は捨てる。
func (w *wsManager) setGws(tabs map[string]gwsRef) {
	w.recomputeMu.Lock() // persist は recompute と同じロックの中で呼ぶ
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	for id, st := range w.reg {
		st.gws = tabs[id]
	}
	w.mu.Unlock()
	w.persist()
}
