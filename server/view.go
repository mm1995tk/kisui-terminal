package server

// 画面（Screen）の配信。設計は docs/design/gui-protocol.md の 3 章「画面（Screen）の送り方」。
//
// GUI は view.subscribe で受け取る領域を選び、view.resize で領域の大きさを送る。shj はフォーカスしている
// ワークスペースの core から Screen を作り、前に送ったものとの差だけを screen.update で送る（view_diff.go）。
// 返事（screen.ack）の来ていない更新は 1 つまでで、その間の変化は ack が来てから 1 つにまとめて送る。
// 画面を作り直すきっかけは ScreenChanged（入力やその他のイベントを処理したあと）。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"

	"github.com/mm1995tk/shijimi-editor/core/screen"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// Screens は、ワークスペースの core から画面を作るもの（cmd が core.Workspaces から渡す）。
// id はワークスペースの id。core が無ければ ok == false。
type Screens interface {
	// Screen は id の core を大きさ v に合わせ、画面を作る。Rev は呼ぶ側が付ける。
	Screen(id string, v screen.View) (sc screen.Screen, ok bool)
	// Theme は今のテーマ。
	Theme(id string) (th Theme, ok bool)
	// Blob は wsID の core が画面に出している画像の中身。無ければ ErrNoBlob。
	Blob(wsID, id string) (mime string, data []byte, err error)
}

// ErrNoBlob は Screens.Blob が、その id の画像が無いときに返す。
var ErrNoBlob = errors.New("no such blob")

// Theme は theme.get の結果と theme.changed の中身。
type Theme struct {
	Name   string                 `json:"name"`
	Tokens map[screen.Style]Token `json:"tokens"`
}

// Token は 1 つの名前の色。Screen では同じ名前を文字の色にも背景にも使う（Span.Bg）ので、色は fg に入れる。
type Token struct {
	Fg        string `json:"fg"`
	Bg        string `json:"bg,omitempty"`
	Bold      bool   `json:"bold,omitempty"`
	Italic    bool   `json:"italic,omitempty"`
	Underline bool   `json:"underline,omitempty"`
}

// ThemeOf は名前 → 色の対応を Theme にする。
func ThemeOf(name string, p screen.Palette) Theme {
	th := Theme{Name: name, Tokens: map[screen.Style]Token{}}
	for st, c := range p {
		th.Tokens[st] = Token{Fg: c}
	}
	return th
}

// blobChunk は blob.get が 1 回で返す最大のバイト数。
const blobChunk = 4 << 20

// guiRegions は GUI が購読できる領域。explorer などは TUI だけのもの。
var guiRegions = []screen.Region{screen.RegionFiles, screen.RegionStatus, screen.RegionCmdline, screen.RegionOverlay}

// viewState は GUI 1 台分の配信の状態（Server.screenMu で守る）。
type viewState struct {
	regions  map[screen.Region]bool
	view     screen.View
	last     *screen.Screen // 最後に送った画面（購読している領域だけ）。nil なら次は全部送る
	lastRoot string         // last を作ったワークスペースのルート
	lastRev  int64          // GUI が持っているはずの版
	inflight int64          // 返事の来ていない更新の版。無ければ 0
	pending  bool           // inflight の間に画面が変わった
	ackSeq   uint64         // 反映した入力の seq の最大（input.go）
	sentAck  uint64         // GUI に送った ackSeq
	theme    *Theme         // 最後に GUI に渡したテーマ。theme.get の前は nil で、theme.changed を送らない
	i18n     *I18n          // 最後に GUI に渡した翻訳の表。i18n.get の前は nil で、i18n.changed を送らない
	blob     struct {       // 分けて取るときに作り直さないよう、最後に取った画像を覚える
		id, mime string
		data     []byte
	}
}

// SetScreens は画面の作り手を決める。無ければ screen.* は not_found を返す。
func (s *Server) SetScreens(sc Screens) {
	s.mu.Lock()
	s.screens = sc
	s.mu.Unlock()
	s.ScreenChanged()
}

func (s *Server) screensOf() Screens {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.screens
}

// ScreenChanged は画面が変わったかもしれないことを知らせる。入力やその他のイベント（LSP の返事、タイマー）を
// 処理したあとに呼ぶ。画面は別の goroutine で作るので、core の中から呼んでもよい。続けて呼ばれても 1 回にまとまる。
func (s *Server) ScreenChanged() {
	select {
	case s.screenKick <- struct{}{}:
	default:
	}
}

// screenLoop は ScreenChanged のたびに画面を作って送る。done が閉じるまで。
func (s *Server) screenLoop(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case <-s.screenKick:
			s.pushScreen()
		}
	}
}

// viewOf は ss の配信の状態。screenMu を持って呼ぶ。
func (ss *session) viewOf() *viewState {
	if ss.view == nil {
		ss.view = &viewState{regions: map[screen.Region]bool{}, view: screen.DefaultView}
	}
	return ss.view
}

// buildScreen はフォーカスしているワークスペースの画面を、購読している領域だけにして作る。
func (s *Server) buildScreen(vs *viewState) (sc screen.Screen, root string, err error) {
	src := s.screensOf()
	root = s.ws.focusID()
	if src == nil || root == "" {
		return sc, "", rpc.Errorf(rpc.CodeNotFound, "no workspace has the focus")
	}
	sc, ok := src.Screen(root, vs.view)
	if !ok {
		return sc, "", rpc.Errorf(rpc.CodeNotFound, "the focused workspace has no core")
	}
	keepRegions(&sc, vs.regions)
	sc.AckSeq = vs.ackSeq
	return sc, root, nil
}

// keepRegions は購読していない領域を落とす。TUI だけの領域はいつも落とす。
func keepRegions(sc *screen.Screen, regions map[screen.Region]bool) {
	if !regions[screen.RegionFiles] {
		sc.Files = nil
	}
	if !regions[screen.RegionStatus] {
		sc.Status = screen.Status{}
	}
	if !regions[screen.RegionCmdline] {
		sc.Cmdline = nil
	}
	if !regions[screen.RegionOverlay] {
		sc.Overlay = nil
	}
}

// pushScreen は今の GUI に、前に送った画面からの差を screen.update で送る。返事を待っている更新があれば、
// 送らずに pending にしておく（screen.ack が来たら送る）。
func (s *Server) pushScreen() {
	s.screenMu.Lock()
	defer s.screenMu.Unlock()
	s.mu.Lock()
	ss := s.owner
	s.mu.Unlock()
	if ss == nil || ss.view == nil {
		return
	}
	vs := ss.view
	if len(vs.regions) == 0 {
		return
	}
	if vs.inflight != 0 {
		vs.pending = true
		return
	}
	vs.pending = false
	sc, root, err := s.buildScreen(vs)
	if err != nil {
		return
	}
	s.pushI18n(ss, vs)
	s.pushTheme(ss, vs, root)
	prev := vs.last
	if root != vs.lastRoot {
		prev = nil // 別のワークスペースの画面になった。全部送る
	}
	upd := diffScreen(prev, &sc, vs.regions)
	if upd == nil {
		if sc.AckSeq == vs.sentAck {
			return
		}
		// 見た目の変わらない入力でも、反映したことは ackSeq で知らせる。
		upd = map[string]any{}
	}
	rev := s.bumpRev()
	upd["rev"], upd["baseRev"], upd["ackSeq"] = rev, vs.lastRev, sc.AckSeq
	sc.Rev = uint64(rev)
	vs.last, vs.lastRoot, vs.lastRev, vs.inflight, vs.sentAck = &sc, root, rev, rev, sc.AckSeq
	if err := ss.conn.Notify("screen.update", upd); err != nil {
		s.log.Info("screen.update", "err", err)
	}
}

// pushTheme はテーマが GUI に渡したものから変わっていれば theme.changed を送る。
func (s *Server) pushTheme(ss *session, vs *viewState, root string) {
	if vs.theme == nil {
		return
	}
	th, ok := s.screensOf().Theme(root)
	if !ok || reflect.DeepEqual(th, *vs.theme) {
		return
	}
	vs.theme = &th
	_ = ss.conn.Notify("theme.changed", th)
}

// viewNotify は screen.ack。
func (ss *session) viewNotify(req *rpc.Message) {
	if req.Method != "screen.ack" || ss.needHello() != nil || ss.isSuperseded() {
		return
	}
	var p struct {
		Rev int64 `json:"rev"`
	}
	if json.Unmarshal(req.Params, &p) != nil {
		return
	}
	s := ss.srv
	s.screenMu.Lock()
	vs := ss.viewOf()
	again := false
	if vs.inflight != 0 && p.Rev >= vs.inflight {
		vs.inflight = 0
		again = vs.pending
	}
	s.screenMu.Unlock()
	if again {
		s.ScreenChanged()
	}
}

// viewRequest は view.* / screen.get / theme.get / blob.get。扱わないメソッドは handled == false。
func (ss *session) viewRequest(req *rpc.Message) (res any, err error, handled bool) {
	switch req.Method {
	case "view.subscribe", "view.resize", "screen.get", "theme.get", "i18n.get", "blob.get":
	default:
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	switch req.Method {
	case "view.subscribe":
		return ss.subscribeReq(req)
	case "view.resize":
		return ss.resizeReq(req)
	case "screen.get":
		return ss.screenGetReq()
	case "theme.get":
		return ss.themeReq()
	case "i18n.get":
		return ss.i18nReq()
	}
	return ss.blobReq(req)
}

func invalidParams(err error) *rpc.Error {
	return rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
}

func (ss *session) subscribeReq(req *rpc.Message) (any, error, bool) {
	var p struct {
		Regions []screen.Region `json:"regions"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err), true
	}
	set := map[screen.Region]bool{}
	for _, r := range p.Regions {
		ok := false
		for _, g := range guiRegions {
			ok = ok || r == g
		}
		if !ok {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "region not served: %s", r), true
		}
		set[r] = true
	}
	s := ss.srv
	s.screenMu.Lock()
	ss.viewOf().regions = set
	s.screenMu.Unlock()
	s.ScreenChanged()
	return struct{}{}, nil, true
}

func (ss *session) resizeReq(req *rpc.Message) (any, error, bool) {
	var p struct {
		Regions map[screen.Region]screen.Size `json:"regions"`
		Splits  *struct {
			Diff    int `json:"diff"`
			Preview int `json:"preview"`
		} `json:"splits"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err), true
	}
	s := ss.srv
	s.screenMu.Lock()
	vs := ss.viewOf()
	v := vs.view
	for r, sz := range p.Regions {
		if sz.Cols < 0 || sz.Rows < 0 {
			s.screenMu.Unlock()
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "negative size of %s", r), true
		}
		switch r {
		case screen.RegionFiles:
			v.Files = sz
		case screen.RegionStatus:
			v.Status = sz
		case screen.RegionCmdline:
			v.Cmdline = sz
		case screen.RegionOverlay:
			v.Overlay = sz
		default:
			s.screenMu.Unlock()
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "region not served: %s", r), true
		}
	}
	if p.Splits != nil {
		if p.Splits.Diff < 0 || p.Splits.Diff > 100 || p.Splits.Preview < 0 || p.Splits.Preview > 100 {
			s.screenMu.Unlock()
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "split share out of range"), true
		}
		v.DiffPct, v.PreviewPct = p.Splits.Diff, p.Splits.Preview
	}
	vs.view = v
	s.screenMu.Unlock()
	s.ScreenChanged()
	return struct{}{}, nil, true
}

// screenGetReq は今の画面を全部返す。以後の screen.update はこの画面からの差になる。
func (ss *session) screenGetReq() (any, error, bool) {
	s := ss.srv
	s.screenMu.Lock()
	vs := ss.viewOf()
	regions := vs.regions
	if len(regions) == 0 {
		// 購読の前でも、GUI が受け取れる領域は全部返す。
		regions = map[screen.Region]bool{}
		for _, r := range guiRegions {
			regions[r] = true
		}
	}
	saved := vs.regions
	vs.regions = regions
	sc, root, err := s.buildScreen(vs)
	vs.regions = saved
	if err != nil {
		s.screenMu.Unlock()
		return nil, err, true
	}
	rev := vs.lastRev
	if vs.last == nil || root != vs.lastRoot || len(saved) == 0 || diffScreen(vs.last, &sc, regions) != nil {
		rev = s.bumpRev()
	}
	sc.Rev = uint64(rev)
	if len(saved) > 0 {
		vs.last, vs.lastRoot = &sc, root
	}
	vs.lastRev, vs.sentAck = rev, sc.AckSeq
	// 返事を待っていた更新は、この画面が置き換える。
	vs.inflight = 0
	again := vs.pending
	s.screenMu.Unlock()
	if again {
		s.ScreenChanged()
	}
	return sc, nil, true
}

func (ss *session) themeReq() (any, error, bool) {
	s := ss.srv
	src := s.screensOf()
	root := s.ws.focusID()
	if src == nil {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no theme"), true
	}
	th, ok := src.Theme(root)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no theme"), true
	}
	s.screenMu.Lock()
	ss.viewOf().theme = &th
	s.screenMu.Unlock()
	return th, nil, true
}

// BlobResult は blob.get の結果。
type BlobResult struct {
	Mime string `json:"mime"`
	Size int    `json:"size"`
	Data string `json:"data"` // base64
	EOF  bool   `json:"eof"`
}

func (ss *session) blobReq(req *rpc.Message) (any, error, bool) {
	var p struct {
		ID     string `json:"id"`
		Offset int    `json:"offset"`
		Length int    `json:"length"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err), true
	}
	if p.Offset < 0 || p.Length < 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "negative offset or length"), true
	}
	s := ss.srv
	src := s.screensOf()
	root := s.ws.focusID()
	if src == nil || root == "" {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no workspace has the focus"), true
	}
	s.screenMu.Lock()
	vs := ss.viewOf()
	mime, data := vs.blob.mime, vs.blob.data
	cached := vs.blob.id == p.ID && p.Offset > 0
	s.screenMu.Unlock()
	if !cached {
		// 頭から取り直すときは、画像が変わっているかもしれないので作り直す。
		var err error
		mime, data, err = src.Blob(root, p.ID)
		if err != nil {
			if errors.Is(err, ErrNoBlob) {
				return nil, rpc.Errorf(rpc.CodeNotFound, "no such blob: %s", p.ID), true
			}
			return nil, rpc.Errorf(rpc.CodeInternalError, "blob %s: %v", p.ID, err), true
		}
		s.screenMu.Lock()
		vs.blob.id, vs.blob.mime, vs.blob.data = p.ID, mime, data
		s.screenMu.Unlock()
	}
	off := min(p.Offset, len(data))
	n := len(data) - off
	if p.Length > 0 {
		n = min(n, p.Length)
	}
	n = min(n, blobChunk)
	return BlobResult{
		Mime: mime,
		Size: len(data),
		Data: base64.StdEncoding.EncodeToString(data[off : off+n]),
		EOF:  off+n >= len(data),
	}, nil, true
}
