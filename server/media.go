package server

// プライマリの shj が開かせる、ターミナルでない欄（動画）。設計は docs/design/gui-protocol.md の「ターミナルでない欄」。
//
// 欄はプライマリの shj（primaryShj）が持つ extras で、shj が終わると一緒に消える。ctl.PaneRequest の "open" で足し、
// "close" か GUI の extra.close で閉じる。中身は GUI が media.read で範囲を指して取る（ssh の向こうにある動画も、
// 同じ接続で GUI に届く）。取れるのは、いま extras にあるファイルだけ。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	"github.com/mm1995tk/shijimi-editor/core"
	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// mediaChunk は media.read が 1 回で返す最大のバイト数。
const mediaChunk = 4 << 20

// extraPane はターミナルでない欄。GUI へは Workspace.extras で届く。
type extraPane struct {
	ID string `json:"id"`
	// Kind は欄の種類。今は "video" だけ。
	Kind string `json:"kind"`
	// Path はファイルの絶対パス。
	Path string `json:"path"`
	// MIME と Size は、GUI が再生できるかと、取る量を決めるため。
	MIME string `json:"mime"`
	Size int64  `json:"size"`
}

// extraCount は claim の shj の extras の数。
func (w *wsManager) extraCount(wsID string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	if st := w.reg[wsID]; st != nil && st.shj != nil {
		return len(st.shj.extras)
	}
	return 0
}

// cellsFree はワークスペースに、あと何個の欄を足せるか（プライマリを含めて 6 個まで。ターミナルも動画も同じ升目に並ぶ）。
func (w *wsManager) cellsFree(wsID string) int {
	return maxSplitTerms - w.srv.terms.countSplit(wsID) - w.extraCount(wsID)
}

// ownExtra は id が claim の shj の作った、ターミナルでない欄か。
func (w *wsManager) ownExtra(claim *primaryShj, id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.ContainsFunc(claim.extras, func(e extraPane) bool { return e.ID == id })
}

// openExtra は ctl.PaneRequest の "open"。動画の欄を 1 つ足して GUI に出させる。動画の欄はワークスペースに 1 つで、
// 開いてあれば新しいものと入れ替える（開くたびに増えて、升目を使い切らないように）。
func (w *wsManager) openExtra(claim *primaryShj, wsID string, rq ctl.PaneRequest) (string, error) {
	if rq.Kind != "video" {
		return "", fmt.Errorf("unknown pane kind: %q", rq.Kind)
	}
	if !filepath.IsAbs(rq.Path) || !core.IsVideo(rq.Path) {
		return "", fmt.Errorf("not a video: %s", rq.Path)
	}
	fi, err := os.Stat(rq.Path)
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("not a file: %s", rq.Path)
	}
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	free := w.cellsFree(wsID)
	w.mu.Lock()
	st := w.reg[wsID]
	if st == nil || st.shj != claim {
		w.mu.Unlock()
		return "", errors.New("the shj of the primary has ended")
	}
	old := slices.IndexFunc(claim.extras, func(e extraPane) bool { return e.Kind == "video" })
	if old < 0 && free <= 0 {
		w.mu.Unlock()
		return "", fmt.Errorf("the workspace already has %d panes", maxSplitTerms+1)
	}
	w.nextExtra++
	e := extraPane{ID: fmt.Sprintf("x%d", w.nextExtra), Kind: "video", Path: rq.Path, MIME: core.VideoMIME(rq.Path), Size: fi.Size()}
	if old >= 0 {
		claim.extras[old] = e
	} else {
		claim.extras = append(claim.extras, e)
	}
	w.mu.Unlock()
	w.recomputeLocked() // workspace.changed が先に届くので、GUI は欄を知っている
	w.srv.notifyOwner("pane.show", map[string]any{"workspaceId": wsID, "extraId": e.ID})
	return e.ID, nil
}

// closeExtra は claim の shj の、ターミナルでない欄を忘れる。
func (w *wsManager) closeExtra(claim *primaryShj, id string) {
	w.mu.Lock()
	claim.extras = slices.DeleteFunc(slices.Clone(claim.extras), func(e extraPane) bool { return e.ID == id })
	w.mu.Unlock()
	w.recompute()
}

// extraOf は id の欄と、その持ち主の shj。無ければ ok == false。
func (w *wsManager) extraOf(wsID, id string) (extraPane, *primaryShj, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if st := w.reg[wsID]; st != nil && st.shj != nil {
		for _, e := range st.shj.extras {
			if e.ID == id {
				return e, st.shj, true
			}
		}
	}
	return extraPane{}, nil, false
}

// mediaRequest は media.read と extra.close を振り分ける。
func (ss *session) mediaRequest(req *rpc.Message) (res any, err error, handled bool) {
	switch req.Method {
	case "media.read":
		res, err = ss.readMediaReq(req)
	case "extra.close":
		res, err = ss.closeExtraReq(req)
	default:
		return nil, nil, false
	}
	return res, err, true
}

// extraParams は media.read と extra.close が欄を指す部分。
type extraParams struct {
	WorkspaceID string `json:"workspaceId"`
	ID          string `json:"id"`
}

// readMediaReq は media.read：欄のファイルの範囲を読む。
func (ss *session) readMediaReq(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var p struct {
		extraParams
		Offset int64 `json:"offset"`
		Length int64 `json:"length"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	e, _, ok := ss.srv.ws.extraOf(p.WorkspaceID, p.ID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such pane: %s", p.ID)
	}
	if p.Offset < 0 || p.Length < 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "negative offset or length")
	}
	r, err := readMedia(e, p.Offset, p.Length)
	if err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "%s: %v", e.Path, err)
	}
	return r, nil
}

// closeExtraReq は extra.close：GUI が欄を閉じる。
func (ss *session) closeExtraReq(req *rpc.Message) (any, error) {
	if err := ss.needHello(); err != nil {
		return nil, err
	}
	var p extraParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err)
	}
	_, claim, ok := ss.srv.ws.extraOf(p.WorkspaceID, p.ID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such pane: %s", p.ID)
	}
	ss.srv.ws.closeExtra(claim, p.ID)
	return struct{}{}, nil
}

// MediaResult は media.read の結果。blob.get と同じ形。
type MediaResult struct {
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	Data string `json:"data"` // base64
	EOF  bool   `json:"eof"`
}

// readMedia は e のファイルの offset から length バイト（0 なら 1 回の上限）を読む。大きさは読むたびに調べる
// （録画の途中で伸びるファイルも、そのとき見えている分は取れる）。
func readMedia(e extraPane, offset, length int64) (MediaResult, error) {
	f, err := os.Open(e.Path)
	if err != nil {
		return MediaResult{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return MediaResult{}, err
	}
	size := fi.Size()
	offset = min(offset, size)
	n := size - offset
	if length > 0 {
		n = min(n, length)
	}
	n = min(n, mediaChunk)
	buf := make([]byte, n)
	got, err := f.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return MediaResult{}, err
	}
	buf = buf[:got]
	return MediaResult{Mime: e.MIME, Size: size, Data: base64.StdEncoding.EncodeToString(buf), EOF: offset+int64(got) >= size}, nil
}
