package server

// プライマリの shj が開かせる、ターミナルでない欄（動画・画像・PDF）と、URL を GUI の手元の外部ブラウザで開かせる通知。設計は docs/design/gui-protocol.md の「ターミナルでないペイン」。
//
// 欄はプライマリの shj（primaryShj）が持つ extras で、shj が終わると一緒に消える。ctl.PaneRequest の "open" で足し、
// "close" か GUI の extra.close で閉じる。中身は GUI が media.read で範囲を指して取る（ssh の向こうにある動画も、
// 同じ接続で GUI に届く）。取れるのは、いま extras にあるファイルだけ。URL（kind が "browser" の要求）は欄を作らず、
// GUI に browser.open の通知を送るだけで、ページは GUI が手元の外部ブラウザで開く。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// mediaChunk は media.read が 1 回で返す最大のバイト数。
const mediaChunk = 4 << 20

// extraPane はターミナルでない欄。GUI へは Workspace.extras で届く。
type extraPane struct {
	ID string `json:"id"`
	// Kind は欄の種類："video"・"image"・"pdf"（fileKinds）。
	Kind string `json:"kind"`
	// Path は動画・画像・PDF のファイルの絶対パス。
	Path string `json:"path"`
	// MIME と Size は、GUI が開けるかと、取る量を決めるため。
	MIME string `json:"mime"`
	Size int64  `json:"size"`
}

// maxOpenURL は GUI に外部ブラウザで開かせる URL の長さの上限（バイト）。
const maxOpenURL = 4096

// newExtra は "open" の rq から欄を作る（ID は付けない）。動画・画像・PDF は絶対パスのそのファイル（種類ごとの拡張子と大きさは fileKinds）。
func newExtra(rq ctl.PaneRequest) (extraPane, error) {
	if _, ok := fileKinds[rq.Kind]; ok {
		return newFileExtra(rq.Kind, rq.Path, fileMIME(rq.Kind, rq.Path))
	}
	return extraPane{}, fmt.Errorf("unknown pane kind: %q", rq.Kind)
}

// newFileExtra は種類 kind（fileKinds）の欄を、絶対パス path のファイルで作る。mime はそのファイルの形式で、空なら断る。
func newFileExtra(kind, path, mime string) (extraPane, error) {
	if !filepath.IsAbs(path) || mime == "" {
		return extraPane{}, fmt.Errorf("not a %s: %s", kind, path)
	}
	fi, err := statRegular(path)
	if err != nil {
		return extraPane{}, err
	}
	return fileExtra(kind, path, mime, fi)
}

// statRegular は path を調べ、通常のファイルでなければ断る。
func statRegular(path string) (os.FileInfo, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("not a file: %s", path)
	}
	return fi, nil
}

// fileExtra は、調べた（statRegular）ファイル fi で種類 kind の欄を作る。種類の大きさの上限を超えれば断る。
func fileExtra(kind, path, mime string, fi os.FileInfo) (extraPane, error) {
	if fk := fileKinds[kind]; fk.maxSize > 0 && fi.Size() > fk.maxSize {
		return extraPane{}, fmt.Errorf("the %s is too large (%d bytes, at most %d): %s", kind, fi.Size(), fk.maxSize, path)
	}
	return extraPane{Kind: kind, Path: path, MIME: mime, Size: fi.Size()}, nil
}

// parseOpenURL は s が外部ブラウザで開いてよい URL（ホストのある http か https。ユーザー名とパスワードを含まない）か確かめ、整えた形を返す。
func parseOpenURL(s string) (string, error) {
	if s == "" || len(s) > maxOpenURL || strings.ContainsFunc(s, unicode.IsControl) {
		return "", fmt.Errorf("invalid URL: %q", s)
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return "", fmt.Errorf("not an http or https URL: %q", s)
	}
	return u.String(), nil
}

// ownExtra は id が claim の shj の作った、ターミナルでない欄か。
func (w *wsManager) ownExtra(claim *primaryShj, id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.ContainsFunc(claim.extras, func(e extraPane) bool { return e.ID == id })
}

// openExtra は ctl.PaneRequest の "open"。動画・画像・PDF の欄を 1 つ足して GUI に出させる（addExtra）。
func (w *wsManager) openExtra(claim *primaryShj, wsID string, rq ctl.PaneRequest) (string, error) {
	e, err := newExtra(rq)
	if err != nil {
		return "", err
	}
	return w.addExtra(wsID, claim, e)
}

// sameKindExtra は st で kind の欄（欄の中から開いたものか、shj が開かせたもの）の id。無ければ ""。w.mu を持って呼ぶ。
func sameKindExtra(st *wsState, kind string) string {
	all := st.extras
	if st.shj != nil {
		all = append(slices.Clone(all), st.shj.extras...)
	}
	for _, x := range all {
		if x.Kind == kind {
			return x.ID
		}
	}
	return ""
}

// addExtra は e をワークスペースの欄に足し、GUI に出させる。claim が nil なら欄の中から開いたもの（閉じるまで残る）、
// そうでなければその shj が開かせたもの（shj が終わると消える）。欄は種類ごとにワークスペースに 1 つで、
// 開いてあれば（どちらが開いたものでも）その場所で新しいものと入れ替える（開くたびに増えないように）。
func (w *wsManager) addExtra(wsID string, claim *primaryShj, e extraPane) (string, error) {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	st := w.reg[wsID]
	if st == nil {
		w.mu.Unlock()
		return "", fmt.Errorf("%w: %s", errNoWorkspace, wsID)
	}
	if claim != nil && st.shj != claim {
		w.mu.Unlock()
		return "", errors.New("the shj of the primary has ended")
	}
	old := sameKindExtra(st, e.Kind)
	w.mu.Unlock()
	// 入れ替えでなければ、新しい欄を足す場所を決める（小さすぎれば断る）
	var target, dir string
	if old == "" {
		var err error
		if target, dir, err = w.planSplit(wsID, "", ""); err != nil {
			return "", err
		}
	}
	w.mu.Lock()
	if w.reg[wsID] != st || (claim != nil && st.shj != claim) || sameKindExtra(st, e.Kind) != old {
		w.mu.Unlock()
		return "", errors.New("the panes changed; try again")
	}
	w.nextExtra++
	e.ID = fmt.Sprintf("x%d", w.nextExtra)
	// 写しを置き換える（recompute が渡した写しと、配列を分け合わないように）
	sameKind := func(x extraPane) bool { return x.Kind == e.Kind }
	st.extras = slices.DeleteFunc(slices.Clone(st.extras), sameKind)
	if st.shj != nil {
		st.shj.extras = slices.DeleteFunc(slices.Clone(st.shj.extras), sameKind)
	}
	if claim != nil {
		claim.extras = append(claim.extras, e)
	} else {
		st.extras = append(st.extras, e)
	}
	if old != "" {
		st.layout = layoutReplace(st.layout, old, e.ID)
		w.mu.Unlock()
	} else {
		w.mu.Unlock()
		w.placePane(wsID, target, dir, e.ID)
	}
	w.recomputeLocked() // workspace.changed が先に届くので、GUI は欄を知っている
	w.srv.notifyOwner("pane.show", map[string]any{"workspaceId": wsID, "extraId": e.ID})
	return e.ID, nil
}

// closeExtra はワークスペースの、ターミナルでない欄 id を忘れる。
func (w *wsManager) closeExtra(wsID, id string) {
	w.mu.Lock()
	if st := w.reg[wsID]; st != nil {
		is := func(e extraPane) bool { return e.ID == id }
		st.extras = slices.DeleteFunc(slices.Clone(st.extras), is)
		if st.shj != nil {
			st.shj.extras = slices.DeleteFunc(slices.Clone(st.shj.extras), is)
		}
	}
	w.mu.Unlock()
	w.recompute()
}

// openURL は URL u を GUI の手元の外部ブラウザで開かせる。欄は作らず、browser.open を GUI に通知するだけ
// （リモートのマシンの localhost 系の URL は、GUI が kisui relay の中継越しに開く）。開かせる GUI が（つながっていなくて）いなければ断る。
// 返す ID は空（欄が無い）。
func (w *wsManager) openURL(wsID, u string) (string, error) {
	u, err := parseOpenURL(u)
	if err != nil {
		return "", err
	}
	w.mu.Lock()
	_, ok := w.reg[wsID]
	w.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("%w: %s", errNoWorkspace, wsID)
	}
	if !w.srv.notifyOwner("browser.open", map[string]any{"workspaceId": wsID, "url": u}) {
		return "", errors.New("no GUI is connected to open the URL")
	}
	return "", nil
}

// extraOf はワークスペースの id の欄。無ければ ok == false。
func (w *wsManager) extraOf(wsID, id string) (extraPane, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	st := w.reg[wsID]
	if st == nil {
		return extraPane{}, false
	}
	all := st.extras
	if st.shj != nil {
		all = append(slices.Clone(all), st.shj.extras...)
	}
	for _, e := range all {
		if e.ID == id {
			return e, true
		}
	}
	return extraPane{}, false
}

// extraIDNum は欄の id（"x<番号>"）の番号。
func extraIDNum(id string) int {
	var n int
	fmt.Sscanf(id, "x%d", &n)
	return n
}

// mediaRequest は media.read・extra.close を振り分ける。
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
	e, ok := ss.srv.ws.extraOf(p.WorkspaceID, p.ID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such pane: %s", p.ID)
	}
	if _, ok := fileKinds[e.Kind]; !ok {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "pane %s has no media", p.ID)
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
	_, ok := ss.srv.ws.extraOf(p.WorkspaceID, p.ID)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such pane: %s", p.ID)
	}
	ss.srv.ws.closeExtra(p.WorkspaceID, p.ID)
	return struct{}{}, nil
}

// MediaResult は media.read の結果。`{mime, size, data (base64), eof}`。1 回に返すのは 4 MiB まで。
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
