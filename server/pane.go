package server

// プライマリの shj が端末のコマンド（Ctrl+`・:sh・:run など）に使う欄。設計は docs/design/gui-protocol.md の「プライマリの shj の欄」。
//
// 欄は同じワークスペースの分割したターミナルで、kisui serve が term.create と同じように始める。頼むのは
// プライマリとして名乗った shj（ctl.PaneRequest。名乗りとは別の接続で 1 回ごと）。見せる・隠すは GUI の状態なので、
// pane.show・pane.hide を GUI に通知するだけにする。shj が終わったら（名乗りの接続が切れたら）その shj の欄を閉じる。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"slices"
	"strings"

	"github.com/charmbracelet/x/ansi"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
)

// paneTailMax は tail で返す行数の上限。
const paneTailMax = 200

// paneConn は ctl.PaneRequest 1 つを受けて、ctl.PaneReply を返す。
func (s *Server) paneConn(c net.Conn, line []byte) {
	var rq ctl.PaneRequest
	if err := json.Unmarshal(line, &rq); err != nil {
		replyPane(c, ctl.PaneReply{Error: err.Error()})
		return
	}
	s.opMu.RLock() // 引き継ぎ（handover.go）の間は待つ
	defer s.opMu.RUnlock()
	if s.isHandedOver() {
		replyPane(c, ctl.PaneReply{Error: errHandedOver.Error()})
		return
	}
	r, err := s.ws.pane(rq)
	if err != nil {
		r = ctl.PaneReply{Error: err.Error()}
	}
	replyPane(c, r)
}

func replyPane(c net.Conn, r ctl.PaneReply) {
	r.OK = r.Error == ""
	b, _ := json.Marshal(r)
	_, _ = c.Write(append(b, '\n'))
}

// claimOf は rq を頼んだ shj が、そのワークスペースのプライマリの shj かを確かめ、その claim とワークスペースを返す。
func (w *wsManager) claimOf(rq ctl.PaneRequest) (*primaryShj, string, error) {
	t, err := w.srv.terms.get(rq.TermID)
	if err != nil {
		return nil, "", err
	}
	t.mu.Lock()
	primary, wsID := t.primary, t.wsID
	t.mu.Unlock()
	if !primary {
		return nil, "", errors.New("not a primary terminal")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	var claim *primaryShj
	if st := w.reg[wsID]; st != nil {
		claim = st.shj
	}
	if claim == nil || claim.PID != rq.PID {
		return nil, "", errors.New("not the shj of the primary")
	}
	return claim, wsID, nil
}

// ownPane は id が claim の shj の作った欄か。
func (w *wsManager) ownPane(claim *primaryShj, id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Contains(claim.panes, id)
}

// pane は rq を行う。頼んだ shj が、そのワークスペースのプライマリの shj でなければ断る。
// split・open・hide・explorer のほかは、その shj が作った欄にだけ効く。
func (w *wsManager) pane(rq ctl.PaneRequest) (ctl.PaneReply, error) {
	claim, wsID, err := w.claimOf(rq)
	if err != nil {
		return ctl.PaneReply{}, err
	}
	switch rq.Op {
	case "split":
		id, err := w.splitPane(claim, wsID, rq)
		return ctl.PaneReply{ID: id}, err
	case "open":
		if rq.Kind == "browser" { // 欄は作らず、GUI の手元の外部ブラウザで開かせる
			id, err := w.openURL(wsID, rq.URL)
			return ctl.PaneReply{ID: id}, err
		}
		id, err := w.openExtra(claim, wsID, rq)
		return ctl.PaneReply{ID: id}, err
	case "hide":
		w.srv.notifyOwner("pane.hide", map[string]any{"workspaceId": wsID})
		return ctl.PaneReply{}, nil
	case "explorer": // ファイルエクスプローラにキーを向けさせる。GUI の状態なので、通知するだけ
		w.srv.notifyOwner("explorer.focus", map[string]any{"workspaceId": wsID})
		return ctl.PaneReply{}, nil
	case "changes": // サイドバーの CHANGES にキーを向けさせる。explorer と同じく通知するだけ
		w.srv.notifyOwner("changes.focus", map[string]any{"workspaceId": wsID})
		return ctl.PaneReply{}, nil
	case "show", "send", "tail", "alive", "close":
	default:
		return ctl.PaneReply{}, fmt.Errorf("unknown op: %q", rq.Op)
	}
	if w.ownExtra(claim, rq.ID) { // ターミナルでない欄に効くのは、見せると閉じるだけ
		switch rq.Op {
		case "show":
			w.srv.notifyOwner("pane.show", map[string]any{"workspaceId": wsID, "extraId": rq.ID})
			return ctl.PaneReply{}, nil
		case "close":
			w.closeExtra(wsID, rq.ID)
			return ctl.PaneReply{}, nil
		}
	}
	if !w.ownPane(claim, rq.ID) {
		if rq.Op == "alive" { // 閉じたあとに聞かれても、いないだけ
			return ctl.PaneReply{}, nil
		}
		return ctl.PaneReply{}, fmt.Errorf("not a pane of this shj: %s", rq.ID)
	}
	if rq.Op == "close" {
		w.closePane(claim, rq.ID)
		return ctl.PaneReply{}, nil
	}
	pt, err := w.srv.terms.get(rq.ID)
	if rq.Op == "alive" {
		return ctl.PaneReply{Alive: err == nil && pt.isAlive()}, nil
	}
	if err != nil {
		return ctl.PaneReply{}, err
	}
	switch rq.Op {
	case "show":
		w.srv.notifyOwner("pane.show", map[string]any{"workspaceId": wsID, "termId": rq.ID})
	case "send":
		text := rq.Text
		if rq.Enter {
			text += "\r"
		}
		ptmx, _ := pt.proc()
		if _, err := ptmx.WriteString(text); err != nil {
			return ctl.PaneReply{}, fmt.Errorf("terminal has exited: %s", rq.ID)
		}
	case "tail":
		return ctl.PaneReply{Lines: pt.tailLines(min(max(rq.N, 1), paneTailMax))}, nil
	}
	return ctl.PaneReply{}, nil
}

// splitPane は claim の shj の欄を 1 つ足して GUI に出させる。フォルダは cwd（無いか、フォルダでなければワークスペースのフォルダ）。
func (w *wsManager) splitPane(claim *primaryShj, wsID string, rq ctl.PaneRequest) (string, error) {
	env, err := validEnv(rq.Env)
	if err != nil {
		return "", err
	}
	dir, ok := w.folderOf(wsID)
	if !ok {
		return "", fmt.Errorf("no such workspace: %s", wsID)
	}
	if fi, err := os.Stat(rq.Cwd); err == nil && fi.IsDir() && rq.Cwd != "" {
		dir = rq.Cwd
	}
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	target, sdir, err := w.planSplit(wsID, "", "")
	if err != nil {
		return "", err
	}
	t, err := w.srv.terms.start(termStart{cols: 80, rows: 24, dir: dir, env: env, wsID: wsID})
	if err != nil {
		return "", err
	}
	// 確かめてから始めるまでの間に shj が終わっていたら、誰も閉じないので、ここで閉じる。
	w.mu.Lock()
	st := w.reg[wsID]
	if st == nil || st.shj != claim {
		w.mu.Unlock()
		w.srv.terms.closeTerm(t.id)
		return "", errors.New("the shj of the primary has ended")
	}
	claim.panes = append(claim.panes, t.id)
	w.mu.Unlock()
	w.placePane(wsID, target, sdir, t.id)
	w.recomputeLocked() // workspace.changed が先に届くので、GUI は欄を知っている
	w.srv.notifyOwner("pane.show", map[string]any{"workspaceId": wsID, "termId": t.id})
	return t.id, nil
}

// closePane は claim の shj の欄を終わらせて忘れる。
func (w *wsManager) closePane(claim *primaryShj, id string) {
	w.mu.Lock()
	claim.panes = slices.DeleteFunc(claim.panes, func(x string) bool { return x == id })
	w.mu.Unlock()
	if !w.closeSplit(id) {
		w.srv.log.Info("pane not closed: it became the primary", "termId", id)
	}
	w.recompute()
}

func (t *terminal) isAlive() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.alive
}

// tailLines は画面の最後の n 行。ターミナルの画面は持たないので、残してある出力から制御列を取り除いて行に分ける。
func (t *terminal) tailLines(n int) []string {
	t.mu.Lock()
	_, data := t.ringBytes(0, t.total)
	t.mu.Unlock()
	text := strings.ReplaceAll(ansi.Strip(string(data)), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(strings.TrimRight(text, "\n \t"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// validEnv は欄に渡す環境変数（"NAME=value"）を確かめる。名前が空・"=" が無い・NUL を含むものがあれば断る。
func validEnv(kvs []string) ([]string, error) {
	var env []string
	for _, kv := range kvs {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" || strings.ContainsRune(kv, 0) {
			return nil, fmt.Errorf("invalid env: %q", kv)
		}
		env = append(env, kv)
	}
	return env, nil
}
