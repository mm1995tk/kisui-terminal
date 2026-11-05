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
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// maxSplitTerms は 1 つのワークスペースの分割したターミナルの上限（プライマリと合わせて 6 個）。
const maxSplitTerms = 5

// Workspace の名前は ctl / ide 用のインターフェースが使っているので、ここでは wsInfo。
// folder・kind・name は、フォルダ未定のあいだ null。
type wsInfo struct {
	ID      string   `json:"id"`
	Folder  *string  `json:"folder"`
	Kind    *string  `json:"kind"` // "git" | "shijimi" | "cwd"
	Name    *string  `json:"name"`
	Branch  string   `json:"branch,omitempty"`
	Primary string   `json:"primary"` // プライマリターミナル
	Terms   []string `json:"terms"`   // 分割したターミナル
	Files   []string `json:"files"`
	// PrimaryShj は GUI のプライマリターミナルの中で動いている TUI の shj。無ければ null。
	PrimaryShj *primaryShj `json:"primaryShj"`

	root string // Folder の値。未定なら ""
	seq  int    // 作った順
}

// wsState はワークスペースの、ターミナルから導けない部分。
type wsState struct {
	id      string
	seq     int
	root    string // 正規化済み。未定なら ""
	kind    string
	primary string // プライマリターミナルの id
	shj     *primaryShj
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
	list      map[string]*wsInfo // 前回の recompute の結果
	focus     string             // フォーカスしているワークスペースの id。無ければ ""
	restoring bool               // restore の途中（persist は書かない）
	saved     []byte             // persist が最後に書いた内容
}

func newWSManager(s *Server) *wsManager {
	home, _ := os.UserHomeDir()
	return &wsManager{srv: s, home: normalizePath(home), reg: map[string]*wsState{}, list: map[string]*wsInfo{}}
}

// resolve は cwd からフォルダを決める。フォルダにしないとき（~ と /）は ok == false。
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

// focusID は画面と入力の宛先になるワークスペースの id。フォーカスが無いか、フォルダ未定なら ""。
func (w *wsManager) focusID() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if st := w.reg[w.focus]; st != nil && st.root != "" {
		return st.id
	}
	return ""
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

// folderOf は新しいシェルを始めるフォルダ（ワークスペースのフォルダ。未定なら start_dir）。
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

// create はフォルダ未定のワークスペースを作り、プライマリターミナルを start_dir で始める。
// start_dir がプロジェクトの中なら、そのままフォルダが決まる。
func (w *wsManager) create() (id, termID string, err error) {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	return w.createLocked(newWorkspaceID(), w.startDir())
}

// createLocked は recomputeMu を持って呼ぶ。wsID のワークスペースを作り、プライマリターミナルを dir で始める。
func (w *wsManager) createLocked(wsID, dir string) (id, termID string, err error) {
	w.mu.Lock()
	w.next++
	st := &wsState{id: wsID, seq: w.next}
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

// recompute は reg と生きているターミナルからワークスペースの一覧を作り直し、前回との差を workspace.changed で通知する。
func (w *wsManager) recompute() {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.recomputeLocked()
}

// recomputeLocked は recomputeMu を持って呼ぶ。
func (w *wsManager) recomputeLocked() {
	cores := w.srv.coresOf()
	terms := w.srv.terms.all()
	w.mu.Lock()
	states := make([]*wsState, 0, len(w.reg))
	for _, st := range w.reg {
		c := *st
		states = append(states, &c)
	}
	w.mu.Unlock()
	next := buildWorkspaces(states, terms, cores)
	w.mu.Lock()
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
func buildWorkspaces(states []*wsState, terms []*terminal, cores Cores) map[string]*wsInfo {
	next := map[string]*wsInfo{}
	for _, st := range states {
		x := &wsInfo{ID: st.id, Primary: st.primary, Terms: []string{}, Files: []string{}, root: st.root, seq: st.seq, PrimaryShj: st.shj}
		if st.root != "" {
			folder, kind, name := st.root, st.kind, filepath.Base(st.root)
			x.Folder, x.Kind, x.Name = &folder, &kind, &name
			if st.kind == "git" {
				x.Branch = gitBranch(st.root)
			}
			if cores != nil {
				x.Files = relFiles(st.root, cores.Files(st.id))
			}
		}
		next[st.id] = x
	}
	for _, t := range terms {
		t.mu.Lock()
		id, primary, tid := t.wsID, t.primary, t.id
		t.mu.Unlock()
		if x := next[id]; x != nil && !primary {
			x.Terms = append(x.Terms, tid)
		}
	}
	for _, x := range next {
		slices.SortFunc(x.Terms, func(a, b string) int { return termIDNum(a) - termIDNum(b) })
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

func sortWS(l []*wsInfo) { sort.Slice(l, func(i, j int) bool { return l[i].seq < l[j].seq }) }

func wsEqual(a, b *wsInfo) bool {
	return a.root == b.root && ptrEq(a.Kind, b.Kind) && a.Branch == b.Branch && a.Primary == b.Primary && a.PrimaryShj == b.PrimaryShj &&
		slices.Equal(a.Terms, b.Terms) && slices.Equal(a.Files, b.Files)
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
			w.poll()
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
		// ~ と / そのものには切り替えない（ファイルも閉じない）。
		if root, kind, ok := w.resolve(cwd); ok {
			w.switchFolder(id, root, kind)
		}
	}
	w.recompute()
}

// switchFolder は id のワークスペースのフォルダを root に切り替える。同じフォルダなら何もしない。
// 開いているファイルは、自動保存の 1 秒を待たずに保存（または設定どおり捨てて）して閉じ、core は作り直す。
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
	focused := w.focus == id
	w.mu.Unlock()
	cores := w.srv.coresOf()
	if cores != nil {
		cores.Release(id)
	}
	w.mu.Lock()
	st.root, st.kind = root, kind
	w.mu.Unlock()
	w.srv.log.Info("workspace folder switched", "workspace", id, "folder", root)
	if focused && cores != nil {
		if err := cores.Open(id, root); err != nil {
			w.srv.log.Warn("open core", "workspace", id, "err", err)
		}
	}
	w.recomputeLocked()
	if focused {
		w.srv.bumpRev()
		w.srv.ScreenChanged()
	}
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
		return busyError("running", nil)
	}
	cores := w.srv.coresOf()
	if cores != nil {
		// 保存できなかったファイルがあれば、force でも何も閉じない（黙ってデータを失わない）。
		if failed := cores.SaveAll(id); len(failed) > 0 {
			return busyError("unsaved", failed)
		}
	}
	w.srv.terms.closeWorkspace(id)
	if cores != nil {
		cores.Close(id)
	}
	w.mu.Lock()
	delete(w.reg, id)
	w.mu.Unlock()
	w.recomputeLocked()
	w.srv.ScreenChanged()
	return nil
}

func busyError(reason string, paths []string) *rpc.Error {
	e := rpc.Errorf(rpc.CodeBusy, "the workspace cannot be closed: %s", reason)
	d := map[string]any{"reason": reason}
	if len(paths) > 0 {
		d["paths"] = paths
	}
	e.Data, _ = json.Marshal(d)
	return e
}

// workspaceRequest は workspace.* のうち返事のあるもの。
func (ss *session) workspaceRequest(req *rpc.Message) (res any, err error, handled bool) {
	switch req.Method {
	case "workspace.list", "workspace.create", "workspace.close", "workspace.focus":
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
	// workspace.focus。フォーカスを移したワークスペースの core を用意する。core は外しても残る。
	// recompute と同じロックの中で、まだワークスペースがあるのを確かめてから作る
	// （消えたあとに作った core は、誰も止めなくなる）。
	w.recomputeMu.Lock()
	w.mu.Lock()
	st := w.reg[p.ID]
	var root, primary string
	if st != nil {
		root, primary = st.root, st.primary
	}
	w.mu.Unlock()
	if st == nil {
		w.recomputeMu.Unlock()
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.ID), true
	}
	if cores := ss.srv.coresOf(); cores != nil && root != "" {
		if err := cores.Open(p.ID, root); err != nil {
			// The workspace does not take the focus: it has no core to show.
			w.recomputeMu.Unlock()
			return nil, rpc.Errorf(rpc.CodeInternalError, "%s", err), true
		}
	}
	w.mu.Lock()
	w.focus = p.ID
	w.mu.Unlock()
	w.recomputeMu.Unlock()
	rev := ss.srv.bumpRev()
	// 画面（Screen）はこのワークスペースの core のものに切り替わる。
	ss.srv.ScreenChanged()
	return map[string]any{"rev": rev, "termId": primary}, nil, true
}
