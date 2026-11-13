package server

// ワークスペース。設計は docs/design/gui-protocol.md の「ワークスペース」。
//
// ワークスペースは作業の単位で、フォルダとは 1 対 1 ではない。workspace.create で作り、
// workspace.close でしか消えない。フォルダは、プライマリターミナルのシェルの cwd だけから決める。
// シェルの cwd を 1 秒に 1 回読み、別のフォルダに変わったら、そのワークスペースのフォルダを切り替える
// （開いているファイルを保存または捨てて閉じ、core を作り直す）。
// 開いているファイルはワークスペースごとの core（Cores）が持つ。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

// wsInfo は workspace.list などで GUI に渡すワークスペース。
// folder・kind・name は、フォルダ未定のあいだ null。
type wsInfo struct {
	ID     string  `json:"id"`
	Folder *string `json:"folder"`
	Kind   *string `json:"kind"` // "git" | "shijimi" | "cwd"
	Name   *string `json:"name"`
	// Label はユーザーがつけた名前（workspace.rename）。つけていなければ省く。GUI は、あれば Name の代わりに出す
	Label string `json:"label,omitempty"`
	// Display は Folder をこのマシンのホームディレクトリ基準で書いた見せる用のパス（~/x）。ホームの外は Folder と同じ。
	// 見せ方だけで、Folder は絶対パスのまま。未定のあいだは省く
	Display string   `json:"display,omitempty"`
	Branch  string   `json:"branch,omitempty"`
	Primary string   `json:"primary"` // プライマリターミナル
	Terms   []string `json:"terms"`   // 分割したターミナル
	// PrimaryShj は GUI のプライマリターミナルの中で動いている TUI の shj。無ければ null。
	PrimaryShj *primaryShj `json:"primaryShj"`
	// Extras はターミナルでない欄（プライマリの shj か、欄の中の kisui open が開かせた動画など。docs/design/gui-protocol.md）。
	Extras []extraPane `json:"extras"`
	// Titles は欄の名前（kisui pane title。欄の id -> 名前）。名前のある欄だけ入る
	Titles map[string]string `json:"titles,omitempty"`
	// Layout は欄の配置（分割の木。layout.go）。葉は primary・terms・extras の id。
	Layout *layoutNode `json:"layout"`

	root string // Folder の値。未定なら ""
	seq  int    // 作った順
}

// wsState はワークスペースの、ターミナルから導けない部分。
type wsState struct {
	id      string
	seq     int
	root    string // 正規化済み。未定なら ""
	kind    string
	label   string // ユーザーがつけた名前（workspace.rename）。無ければ ""。w.mu で守る
	primary string // プライマリターミナルの id
	shj     *primaryShj
	extras  []extraPane // 欄の中から（kisui open で）開いた、ターミナルでない欄。w.mu で守る。閉じるまで残る（shj が終わっても消えない）
	layout  *layoutNode // 欄の配置。recompute のたびに、いまある欄に合わせる
}

type wsManager struct {
	srv *Server
	// recomputeMu は recompute 全体と、フォルダの切り替え・閉じる・フォーカスを 1 つずつにする（通知の順序を保つ）。
	recomputeMu sync.Mutex
	// linkMu は GUI のリンク（ctl.GUILinkPath）の置き換えと消去を 1 つずつにする。
	linkMu sync.Mutex

	mu        sync.Mutex
	home      string
	reg       map[string]*wsState // id -> ワークスペース
	next      int
	nextExtra int                // ターミナルでない欄の id の連番
	list      map[string]*wsInfo // 前回の recompute の結果
	focus     string             // フォーカスしているワークスペースの id。無ければ ""
	restoring bool               // restore の途中（persist は書かない）
	saved     []byte             // persist が最後に書いた内容
}

func newWSManager(s *Server) *wsManager {
	home, _ := os.UserHomeDir()
	return &wsManager{srv: s, home: normalizePath(home), reg: map[string]*wsState{}, list: map[string]*wsInfo{}}
}

// resolve は cwd からフォルダを決める。cwd が絶対パスでないときは ok == false。
func (w *wsManager) resolve(cwd string) (root, kind string, ok bool) {
	return findRoot(normalizePath(cwd), w.home)
}

// startDir は新しいワークスペースのプライマリターミナルが始まるフォルダ（[server] start_dir、無ければ ~）。
func (w *wsManager) startDir() string {
	if d := w.srv.opts.StartDir; d != "" {
		return d
	}
	if w.home != "" {
		return w.home
	}
	return "/"
}

// newWorkspaceID は不透明なワークスペースの id。フォルダのパスからは作らない。
func newWorkspaceID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "w" + hex.EncodeToString(b[:])
}

// snapshot は今のワークスペースの一覧（作った順）と focus。
func (w *wsManager) snapshot() ([]*wsInfo, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]*wsInfo, 0, len(w.list))
	for _, x := range w.list {
		out = append(out, x)
	}
	sortWS(out)
	return out, w.focus
}

func (w *wsManager) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.reg)
}

// rootOf は id のワークスペースのフォルダ（正規化済み）。無いか、フォルダ未定なら ok == false。
func (w *wsManager) rootOf(id string) (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	st := w.reg[id]
	if st == nil || st.root == "" {
		return "", false
	}
	return st.root, true
}

// tracksGit は id のワークスペースが git の印を取る対象かどうか。kind が "cwd"（目印が無い、または ~ と / そのもの）
// のものは取らない。"shijimi" は git の中にあることがある（.git のあるフォルダの下の .shijimi-editor/）ので取る。
func (w *wsManager) tracksGit(id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	st := w.reg[id]
	return st != nil && st.root != "" && st.kind != "cwd"
}

// folderOf は新しいシェルを始めるフォルダ（ワークスペースのフォルダ。決まっていなければ start_dir）。
func (w *wsManager) folderOf(id string) (string, bool) {
	w.mu.Lock()
	st := w.reg[id]
	var root string
	if st != nil {
		root = st.root
	}
	w.mu.Unlock()
	if st == nil {
		return "", false
	}
	if root != "" {
		return root, true
	}
	return w.startDir(), true
}

// create はワークスペースを作り、プライマリターミナルを start_dir で始める。
// フォルダは start_dir から決まる（プロジェクトの中ならそのルート、~ なら ~）。
func (w *wsManager) create() (id, termID string, err error) {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	return w.createLocked(newWorkspaceID(), w.startDir(), "")
}

// createLocked は recomputeMu を持って呼ぶ。wsID のワークスペースを作り、プライマリターミナルを dir で始める。
func (w *wsManager) createLocked(wsID, dir, label string) (id, termID string, err error) {
	w.mu.Lock()
	w.next++
	st := &wsState{id: wsID, seq: w.next, label: label}
	if root, kind, ok := w.resolve(dir); ok {
		st.root, st.kind = root, kind
	}
	w.mu.Unlock()
	t, err := w.srv.terms.start(termStart{cols: 80, rows: 24, dir: dir, wsID: st.id, primary: true})
	if err != nil {
		return "", "", err
	}
	st.primary = t.id
	w.mu.Lock()
	w.reg[st.id] = st
	w.mu.Unlock()
	w.recomputeLocked()
	return st.id, t.id, nil
}

// promote は、プライマリターミナル old のシェルが終わったとき、同じワークスペースに生きている分割した
// ターミナルがあれば、その 1 つをプライマリにして、元のプライマリの欄を閉じる（term.close と同じ）。
// 選ぶのは、いちばん前に作った（id の番号が小さい）もの。分割したターミナルが無ければ何もしない
// （欄は残り、term.restart で新しいシェルを始める）。分割した欄のシェルにも環境変数
// SHIJIMI_GUI_PRIMARY（値はその欄の id）を渡してあるので、昇格したあとに起動した shj は名乗れる
// （昇格の前は claimShj がプライマリでないと断る）。
func (w *wsManager) promote(old *terminal) bool {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	old.mu.Lock()
	primary, wsID := old.primary, old.wsID
	old.mu.Unlock()
	if !primary {
		return false
	}
	// ワークスペースやサーバーを閉じている途中で、すでに外されたターミナルのときは何もしない
	if t, err := w.srv.terms.get(old.id); err != nil || t != old {
		return false
	}
	w.mu.Lock()
	st := w.reg[wsID]
	ok := st != nil && st.primary == old.id
	w.mu.Unlock()
	if !ok {
		return false
	}
	var next *terminal
	for _, t := range w.srv.terms.all() { // all は作った順ではないので、番号の小さいものを選ぶ
		t.mu.Lock()
		cand := t.wsID == wsID && !t.primary && t.alive
		t.mu.Unlock()
		w.mu.Lock()
		opened := st.shj != nil && slices.Contains(st.shj.panes, t.id)
		w.mu.Unlock()
		if cand && opened {
			cand = false // shj が開いた欄は、shj と一緒に閉じるので昇格させない
		}
		if cand && (next == nil || termIDNum(t.id) < termIDNum(next.id)) {
			next = t
		}
	}
	if next == nil {
		return false
	}
	next.mu.Lock()
	next.primary = true
	next.mu.Unlock()
	w.mu.Lock()
	st.primary = next.id
	w.mu.Unlock()
	w.srv.terms.closeTerm(old.id)
	w.srv.log.Info("primary promoted", "workspace", wsID, "from", old.id, "to", next.id)
	w.recomputeLocked()
	return true
}

// closeSplit は分割したターミナル id を閉じる。プライマリなら閉じず false。promote と同じ recomputeMu の中で
// 確かめて閉じるので、確かめたあとに昇格したターミナルを閉じてしまうことがない。
func (w *wsManager) closeSplit(id string) bool {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	t, err := w.srv.terms.get(id)
	if err != nil {
		return true // もう無い
	}
	t.mu.Lock()
	primary := t.primary
	t.mu.Unlock()
	if primary {
		return false
	}
	w.srv.terms.closeTerm(id)
	return true
}

// recompute は reg と生きているターミナルからワークスペースの一覧を作り直し、前回との差を workspace.changed で通知する。
func (w *wsManager) recompute() {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.recomputeLocked()
}

// recomputeLocked は recomputeMu を持って呼ぶ。
func (w *wsManager) recomputeLocked() {
	terms := w.srv.terms.all()
	w.mu.Lock()
	states := make([]*wsState, 0, len(w.reg))
	for _, st := range w.reg {
		c := *st
		c.extras = slices.Clone(c.extras)
		if c.shj != nil {
			cp := *c.shj // File は後から変わるので、写しを渡す
			cp.extras = slices.Clone(cp.extras)
			c.shj = &cp
		}
		states = append(states, &c)
	}
	w.mu.Unlock()
	next := buildWorkspaces(states, terms, w.home)
	w.mu.Lock()
	for id, x := range next {
		if st := w.reg[id]; st != nil {
			st.layout = x.Layout
		}
	}
	prev := w.list
	w.list = next
	if _, ok := w.reg[w.focus]; !ok {
		// フォーカスが消えた。GUI は removed から知る。画面（Screen）は次のフォーカスまで送らない。
		w.focus = ""
	}
	added, updated, removed := diffWorkspaces(prev, next)
	w.mu.Unlock()
	if p := changedParams(added, updated, removed); p != nil {
		w.srv.notifyOwner("workspace.changed", p)
	}
	w.persist()
}

// buildWorkspaces はワークスペースの一覧を作る。分割したターミナルは属するワークスペースごとにまとめる。
func buildWorkspaces(states []*wsState, terms []*terminal, home string) map[string]*wsInfo {
	next := map[string]*wsInfo{}
	for _, st := range states {
		x := &wsInfo{ID: st.id, Primary: st.primary, Terms: []string{}, Extras: []extraPane{}, root: st.root, seq: st.seq, PrimaryShj: st.shj, Label: st.label}
		if st.root != "" {
			folder, kind, name := st.root, st.kind, filepath.Base(st.root)
			x.Folder, x.Kind, x.Name = &folder, &kind, &name
			x.Display = tildePath(folder, home)
			if st.kind == "git" {
				x.Branch = gitBranch(st.root)
			}
		}
		x.Extras = append(x.Extras, st.extras...)
		if st.shj != nil {
			x.Extras = append(x.Extras, st.shj.extras...)
		}
		// 欄の中から開いたものと shj が開かせたものを、開いた順（id の番号の順）に並べる
		slices.SortStableFunc(x.Extras, func(a, b extraPane) int { return extraIDNum(a.ID) - extraIDNum(b.ID) })
		next[st.id] = x
	}
	for _, t := range terms {
		t.mu.Lock()
		id, primary, tid, name := t.wsID, t.primary, t.id, t.name
		t.mu.Unlock()
		x := next[id]
		if x == nil {
			continue
		}
		if !primary {
			x.Terms = append(x.Terms, tid)
		}
		if name != "" {
			if x.Titles == nil {
				x.Titles = map[string]string{}
			}
			x.Titles[tid] = name
		}
	}
	layouts := map[string]*layoutNode{}
	for _, st := range states {
		layouts[st.id] = st.layout
	}
	for id, x := range next {
		slices.SortFunc(x.Terms, func(a, b string) int { return termIDNum(a) - termIDNum(b) })
		live := append([]string{x.Primary}, x.Terms...)
		for _, e := range x.Extras {
			live = append(live, e.ID)
		}
		x.Layout = layoutReconcile(layouts[id], live)
	}
	return next
}

// diffWorkspaces は前回と今回の差。
func diffWorkspaces(prev, next map[string]*wsInfo) (added, updated []*wsInfo, removed []string) {
	for id, x := range next {
		p, ok := prev[id]
		switch {
		case !ok:
			added = append(added, x)
		case !wsEqual(p, x):
			updated = append(updated, x)
		}
	}
	for id := range prev {
		if _, ok := next[id]; !ok {
			removed = append(removed, id)
		}
	}
	sortWS(added)
	sortWS(updated)
	slices.Sort(removed)
	return
}

// changedParams は workspace.changed のパラメータ。差が無ければ nil。
func changedParams(added, updated []*wsInfo, removed []string) map[string]any {
	if len(added)+len(updated)+len(removed) == 0 {
		return nil
	}
	p := map[string]any{}
	if len(added) > 0 {
		p["added"] = added
	}
	if len(removed) > 0 {
		p["removed"] = removed
	}
	if len(updated) > 0 {
		p["updated"] = updated
	}
	return p
}

// tildePath は p がホームディレクトリの中なら、ホームの部分を ~ にしたパスを返す。外なら p のまま。
func tildePath(p, home string) string {
	if home == "" || home == "/" {
		return p
	}
	if p == home {
		return "~"
	}
	if rest, ok := strings.CutPrefix(p, home+"/"); ok {
		return "~/" + rest
	}
	return p
}

func sortWS(l []*wsInfo) { sort.Slice(l, func(i, j int) bool { return l[i].seq < l[j].seq }) }

func wsEqual(a, b *wsInfo) bool {
	return a.root == b.root && a.Label == b.Label && ptrEq(a.Kind, b.Kind) && a.Branch == b.Branch && a.Primary == b.Primary && shjEq(a.PrimaryShj, b.PrimaryShj) &&
		slices.Equal(a.Terms, b.Terms) && slices.Equal(a.Extras, b.Extras) && maps.Equal(a.Titles, b.Titles) && layoutEqual(a.Layout, b.Layout)
}

func ptrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// watch は cwd を 1 秒に 1 回（Options.CwdInterval）読む。done が閉じるまで。
func (w *wsManager) watch(done <-chan struct{}) {
	iv := w.srv.opts.CwdInterval
	if iv <= 0 {
		iv = time.Second
	}
	tk := time.NewTicker(iv)
	defer tk.Stop()
	for {
		select {
		case <-done:
			return
		case <-tk.C:
			w.srv.whileServing(w.poll)
		}
	}
}

// poll は全ターミナルの cwd を読む。ワークスペースのフォルダを動かすのはプライマリターミナルだけ。
// ブランチの変化も拾うので recompute も毎回する。
func (w *wsManager) poll() {
	for _, t := range w.srv.terms.all() {
		t.mu.Lock()
		alive, pid, old, primary, id := t.alive, t.pid, t.cwd, t.primary, t.wsID
		t.mu.Unlock()
		if !alive {
			continue
		}
		cwd, err := shellCwd(pid)
		if err != nil || cwd == "" || cwd == old {
			continue
		}
		t.mu.Lock()
		t.cwd = cwd
		t.mu.Unlock()
		if !primary {
			continue
		}
		if root, kind, ok := w.resolve(cwd); ok {
			w.switchFolder(id, root, kind)
		}
	}
	w.recompute()
}

// switchFolder は id のワークスペースのフォルダを root に切り替える。同じフォルダなら何もしない。
// 分割したターミナルはそのまま残す。
func (w *wsManager) switchFolder(id, root, kind string) {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	st := w.reg[id]
	if st == nil || st.root == root {
		w.mu.Unlock()
		return
	}
	st.root, st.kind = root, kind
	w.mu.Unlock()
	w.srv.log.Info("workspace folder switched", "workspace", id, "folder", root)
	w.recomputeLocked()
}

// running はワークスペースのターミナルのうち、シェルのほかにプログラムが動いているもの。
func (w *wsManager) running(id string) []*terminal {
	var out []*terminal
	for _, t := range w.srv.terms.all() {
		t.mu.Lock()
		mine := t.wsID == id
		t.mu.Unlock()
		if mine && t.busy() {
			out = append(out, t)
		}
	}
	return out
}

// closeWorkspace は workspace.close。
func (w *wsManager) closeWorkspace(id string, force bool) error {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	st := w.reg[id]
	w.mu.Unlock()
	if st == nil {
		return rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", id)
	}
	if !force && len(w.running(id)) > 0 {
		return busyError("running")
	}
	w.srv.terms.closeWorkspace(id)
	w.mu.Lock()
	delete(w.reg, id)
	w.mu.Unlock()
	w.recomputeLocked()
	return nil
}

// rename は id のワークスペースにユーザーの名前をつける。空（前後の空白を除いて）なら外して、自動の名前に戻す。
// 名前は保存し（persist）、引き継ぎでも渡す。長さと文字の決まりはペインの名前と同じ（cleanPaneName）。
func (w *wsManager) rename(id, name string) *rpc.Error {
	name, err := cleanPaneName(name)
	if err != nil {
		e := rpc.Errorf(rpc.CodeInvalidParams, "%v", err)
		// 理由は data にも載せる（GUI は文の中身でなく、これで言い換える）
		switch {
		case errors.Is(err, errNameTooLong):
			e.Data, _ = json.Marshal(map[string]any{"reason": "too_long", "max": maxPaneName})
		case errors.Is(err, errNameControl):
			e.Data, _ = json.Marshal(map[string]any{"reason": "control_character"})
		}
		return e
	}
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	st := w.reg[id]
	if st != nil {
		st.label = name
	}
	w.mu.Unlock()
	if st == nil {
		return rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", id)
	}
	w.recomputeLocked()
	return nil
}

func busyError(reason string) *rpc.Error {
	e := rpc.Errorf(rpc.CodeBusy, "the workspace cannot be closed: %s", reason)
	e.Data, _ = json.Marshal(map[string]any{"reason": reason})
	return e
}

// workspaceRequest は workspace.* のうち返事のあるもの。
func (ss *session) workspaceRequest(req *rpc.Message) (res any, err error, handled bool) {
	switch req.Method {
	case "workspace.list", "workspace.create", "workspace.close", "workspace.focus", "workspace.rename", "layout.resize", "layout.swap":
	default:
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	w := ss.srv.ws
	switch req.Method {
	case "workspace.list":
		l, f := w.snapshot()
		var focus any
		if f != "" {
			focus = f
		}
		return map[string]any{"workspaces": l, "focus": focus}, nil, true
	case "workspace.create":
		id, termID, err := w.create()
		if err != nil {
			return nil, err, true
		}
		return map[string]any{"id": id, "termId": termID}, nil, true
	}
	if req.Method == "layout.resize" {
		var lp struct {
			WorkspaceID string   `json:"workspaceId"`
			Pane        string   `json:"pane"`
			Ratio       *float64 `json:"ratio"`
		}
		if err := json.Unmarshal(req.Params, &lp); err != nil || lp.Ratio == nil || lp.Pane == "" {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "workspaceId, pane and ratio are required"), true
		}
		r, err := w.resizeBorder(lp.WorkspaceID, lp.Pane, *lp.Ratio)
		switch {
		case err == nil:
			return map[string]any{"ratio": r}, nil, true
		case errors.Is(err, errNoWorkspace), errors.Is(err, errNoBorder):
			return nil, rpc.Errorf(rpc.CodeNotFound, "%v", err), true
		case errors.Is(err, errTooSmall):
			return nil, rpc.Errorf(rpc.CodeBusy, "%v", err), true
		}
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "%v", err), true
	}
	if req.Method == "layout.swap" {
		var sp struct {
			WorkspaceID string `json:"workspaceId"`
			Pane        string `json:"pane"`
			Other       string `json:"other"`
		}
		if err := json.Unmarshal(req.Params, &sp); err != nil || sp.Pane == "" || sp.Other == "" || sp.Pane == sp.Other {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "workspaceId, pane and other (a different pane) are required"), true
		}
		switch err := w.swapPanes(sp.WorkspaceID, sp.Pane, sp.Other); {
		case err == nil:
			return struct{}{}, nil, true
		case errors.Is(err, errNoWorkspace), errors.Is(err, errNoPane):
			return nil, rpc.Errorf(rpc.CodeNotFound, "%v", err), true
		}
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "%v", err), true
	}
	if req.Method == "workspace.rename" {
		var rp struct {
			ID   string  `json:"id"`
			Name *string `json:"name"`
		}
		if err := json.Unmarshal(req.Params, &rp); err != nil || rp.ID == "" || rp.Name == nil {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "id and name are required"), true
		}
		if err := w.rename(rp.ID, *rp.Name); err != nil {
			return nil, err, true
		}
		return struct{}{}, nil, true
	}
	var p struct {
		ID    string `json:"id"`
		Force bool   `json:"force"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err), true
	}
	if req.Method == "workspace.close" {
		if err := w.closeWorkspace(p.ID, p.Force); err != nil {
			return nil, err, true
		}
		return struct{}{}, nil, true
	}
	// workspace.focus。recompute と同じロックの中で、まだワークスペースがあるのを確かめてから移す。
	w.recomputeMu.Lock()
	w.mu.Lock()
	st := w.reg[p.ID]
	var primary string
	if st != nil {
		primary = st.primary
	}
	w.mu.Unlock()
	if st == nil {
		w.recomputeMu.Unlock()
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.ID), true
	}
	w.mu.Lock()
	w.focus = p.ID
	w.mu.Unlock()
	w.recomputeMu.Unlock()
	rev := ss.srv.bumpRev()
	return map[string]any{"rev": rev, "termId": primary}, nil, true
}

func shjEq(a, b *primaryShj) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Socket == b.Socket && a.PID == b.PID && a.File == b.File && diffEq(a.Diff, b.Diff) && a.wsID == b.wsID
}
