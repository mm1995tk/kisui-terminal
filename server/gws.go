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

// cleanGwsRef は、窓が知らせた（または保存していた）窓のワークスペースを、覚えられる形にする。id が使えない（空・長すぎる・
// 制御文字がある。cleanPaneName）ときだけ断る。名前は断らずに直す：制御文字は空白に替え、長すぎれば maxPaneName 文字で切る。
// 名前の決まりは窓が持ち、窓の決まりは serve の unicode.IsControl より狭く（C1 の制御文字を通す）、窓は保存してあった記録を
// 読むときに長さを確かめ直さないので、ここで断ると、窓からは直せないまま、そのワークスペースが出なくなる。
func cleanGwsRef(g gwsRef) (gwsRef, error) {
	id, err := cleanPaneName(g.ID)
	if err != nil {
		return gwsRef{}, err
	}
	if id == "" {
		return gwsRef{}, errNoGwsID
	}
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, g.Name))
	if r := []rune(name); len(r) > maxPaneName {
		name = strings.TrimSpace(string(r[:maxPaneName]))
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
		// id が使えないタブは、その 1 つだけ対応を空にする（知らせを丸ごと断ると、その 1 つのために、このマシンのほかのタブの
		// ワークスペースも出なくなり、窓には何も出ないので気づけない）
		g, err := cleanGwsRef(x.gwsRef)
		if err != nil {
			ss.srv.log.Warn("gws.set: a tab is left without a workspace", "workspace", x.WorkspaceID, "err", err)
			continue
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
