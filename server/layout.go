package server

// 欄の配置（分割の木）。設計は docs/design/gui-protocol.md の「ペインの配置」。
//
// ワークスペースの欄（プライマリ・分割したターミナル・ターミナルでない欄）は 1 本の木に入る。葉が欄で、
// 内側の節は「右に分ける（Dir == "right"。A が左、B が右。境界は縦）」か「下に分ける（Dir == "down"。
// A が上、B が下。境界は横）」。Ratio は A の割合（0〜1。分けた直後は 0.5。layout.resize で変わる）。
// 木は serve が持ち（wsState.layout）、workspace.list・workspace.changed の Workspace.layout で GUI に渡す。
// GUI を開き直しても別の GUI からつないでも同じ配置になり、serve の入れ替え（handover）でも引き継ぐ。
//
// 木のノードは作ったあとに書き換えない（変えるときは新しい木を返す）ので、写しを渡さずに共有してよい。

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"
)

// 欄を分けるときの、分けた後の欄の最小の大きさ（端末の列と行）。
const (
	minSplitCols = 20
	minSplitRows = 5
)

// planSplit の失敗の種類。term.create は、小さすぎるときだけ busy にし、呼ぶ側の誤りは not_found・invalid_params にする。
var (
	errTooSmall    = errors.New("too small")
	errNoWorkspace = errors.New("no such workspace")
	errNoPane      = errors.New("no such pane")
	errBadDir      = errors.New("invalid split direction")
	errBadSwap     = errors.New("cannot swap a pane with itself")
)

const (
	dirRight = "right"
	dirDown  = "down"
	// 分けるときの向きには、木の Dir にならない "left" と "up" もある。木の形は変えず、新しい欄を A に、今の欄を B にして表す。
	dirLeft = "left"
	dirUp   = "up"
)

// layoutNode は分割の木の節か葉。Pane が空でなければ葉。
type layoutNode struct {
	Pane  string      `json:"pane,omitempty"`
	Dir   string      `json:"dir,omitempty"`
	Ratio float64     `json:"ratio,omitempty"`
	A     *layoutNode `json:"a,omitempty"`
	B     *layoutNode `json:"b,omitempty"`
}

func leaf(id string) *layoutNode { return &layoutNode{Pane: id} }

func (n *layoutNode) isLeaf() bool { return n != nil && n.Pane != "" }

// layoutPanes は葉の欄の id（左上から順）。
func layoutPanes(n *layoutNode) []string {
	if n == nil {
		return nil
	}
	if n.isLeaf() {
		return []string{n.Pane}
	}
	return append(layoutPanes(n.A), layoutPanes(n.B)...)
}

func layoutHas(n *layoutNode, id string) bool {
	return slices.Contains(layoutPanes(n), id)
}

func layoutEqual(a, b *layoutNode) bool { return reflect.DeepEqual(a, b) }

// validLayout は n が正しい木か（葉は欄の id だけ、節は A と B と向きと 0〜1 の割合を持つ）。handover で受けた木を確かめるのに使う。
func validLayout(n *layoutNode) bool {
	if n == nil {
		return false
	}
	if n.isLeaf() {
		return n.A == nil && n.B == nil
	}
	return (n.Dir == dirRight || n.Dir == dirDown) && n.Ratio > 0 && n.Ratio < 1 && validLayout(n.A) && validLayout(n.B)
}

// splitNode は葉 n を、n と id の 2 枚の節に替える。dir が right・down なら id が B（右・下）、
// left・up なら id が A（左・上）で、節の Dir は right か down のまま。dir が 4 つのどれでもなければ nil
// （分ける向きと木の向きは別のもので、4 つ以外は木に入れない）。
func splitNode(n *layoutNode, id, dir string) *layoutNode {
	switch dir {
	case dirLeft:
		return &layoutNode{Dir: dirRight, Ratio: 0.5, A: leaf(id), B: n}
	case dirUp:
		return &layoutNode{Dir: dirDown, Ratio: 0.5, A: leaf(id), B: n}
	case dirRight, dirDown:
		return &layoutNode{Dir: dir, Ratio: 0.5, A: n, B: leaf(id)}
	}
	return nil
}

// validSplitDir は分けるときの向きとして正しいか。
func validSplitDir(dir string) bool {
	switch dir {
	case dirRight, dirDown, dirLeft, dirUp:
		return true
	}
	return false
}

// layoutSplit は target の葉を、target と id の 2 枚の節に替えた木。target が無ければ ok == false。
// dir は right・down・left・up（splitNode）。
func layoutSplit(n *layoutNode, target, id, dir string) (*layoutNode, bool) {
	if n == nil {
		return nil, false
	}
	if n.isLeaf() {
		if n.Pane != target {
			return n, false
		}
		if s := splitNode(n, id, dir); s != nil {
			return s, true
		}
		return n, false
	}
	if a, ok := layoutSplit(n.A, target, id, dir); ok {
		return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: a, B: n.B}, true
	}
	if b, ok := layoutSplit(n.B, target, id, dir); ok {
		return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: n.A, B: b}, true
	}
	return n, false
}

// layoutReplace は葉 old を id に替えた木。
func layoutReplace(n *layoutNode, old, id string) *layoutNode {
	if n == nil {
		return nil
	}
	if n.isLeaf() {
		if n.Pane == old {
			return leaf(id)
		}
		return n
	}
	return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: layoutReplace(n.A, old, id), B: layoutReplace(n.B, old, id)}
}

// layoutSwap は葉 x と葉 y の場所を入れ替えた木。節の向きと割合はその場所のまま変えない（割合は「場所」の
// 大きさなので、入れ替えたあとも同じ位置が同じ大きさで残る）。どちらかが木に無ければ errNoPane、
// x と y が同じ欄なら errBadSwap（このとき木は変えない）。確かめる場所はここだけ。
func layoutSwap(n *layoutNode, x, y string) (*layoutNode, error) {
	if x == y {
		return n, fmt.Errorf("%w: %s", errBadSwap, x)
	}
	for _, id := range []string{x, y} {
		if !layoutHas(n, id) {
			return n, fmt.Errorf("%w: %s", errNoPane, id)
		}
	}
	var rec func(n *layoutNode) *layoutNode
	rec = func(n *layoutNode) *layoutNode {
		if n.isLeaf() {
			switch n.Pane {
			case x:
				return leaf(y)
			case y:
				return leaf(x)
			}
			return n
		}
		return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: rec(n.A), B: rec(n.B)}
	}
	return rec(n), nil
}

// layoutPrune は live に無い葉と重なった葉を外す。節の片方が無くなれば、もう片方がその場所を埋める。全部無くなれば nil。
func layoutPrune(n *layoutNode, live map[string]bool, seen map[string]bool) *layoutNode {
	if n == nil {
		return nil
	}
	if n.isLeaf() {
		if !live[n.Pane] || seen[n.Pane] {
			return nil
		}
		seen[n.Pane] = true
		return n
	}
	a := layoutPrune(n.A, live, seen)
	b := layoutPrune(n.B, live, seen)
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case a == n.A && b == n.B:
		return n
	}
	return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: a, B: b}
}

// autoTarget は自動で欄を足すときに分ける欄と向き。木の最後の葉を、深さが偶数なら右に、奇数なら下に分ける。
func autoTarget(n *layoutNode) (target, dir string) {
	depth := 0
	for n != nil && !n.isLeaf() {
		n = n.B
		depth++
	}
	if n == nil {
		return "", dirRight
	}
	if depth%2 == 0 {
		return n.Pane, dirRight
	}
	return n.Pane, dirDown
}

// layoutReconcile は木を、いま生きている欄（live。先頭がプライマリ）に合わせる。無くなった欄は外して隣が埋め、
// 木に無い欄（古い GUI が term.create した・古い serve から引き継いだ）は autoTarget の場所に足す。
func layoutReconcile(n *layoutNode, live []string) *layoutNode {
	set := make(map[string]bool, len(live))
	for _, id := range live {
		set[id] = true
	}
	n = layoutPrune(n, set, map[string]bool{})
	for _, id := range live {
		switch {
		case n == nil:
			n = leaf(id)
		case !layoutHas(n, id):
			t, d := autoTarget(n)
			n, _ = layoutSplit(n, t, id, d)
		}
	}
	return n
}

// checkSplit は target を dir に分けてよいか。分けた後の欄が最小の大きさ（minSplitCols 列・minSplitRows 行）を
// 下回るなら断る。大きさが分かるのはターミナルだけで、ターミナルでない欄は断らない。
func (w *wsManager) checkSplit(target, dir string) error {
	t, err := w.srv.terms.get(target)
	if err != nil {
		return nil
	}
	t.mu.Lock()
	cols, rows := t.cols, t.rows
	t.mu.Unlock()
	switch dir {
	case dirRight, dirLeft:
		if c := cols / 2; c < minSplitCols {
			return fmt.Errorf("%w: the pane is too narrow to split %s: %d columns would be left (at least %d)", errTooSmall, dir, c, minSplitCols)
		}
	case dirDown, dirUp:
		if r := rows / 2; r < minSplitRows {
			return fmt.Errorf("%w: the pane is too short to split %s: %d rows would be left (at least %d)", errTooSmall, dir, r, minSplitRows)
		}
	}
	return nil
}

// planSplit は recomputeMu を持って呼ぶ。wsID のワークスペースで、新しい欄を足す場所を決める。
// target が空なら自動（autoTarget）。向きが "" なら自動のときだけ許す。最小の大きさを下回るなら断る。
func (w *wsManager) planSplit(wsID, target, dir string) (string, string, error) {
	w.mu.Lock()
	st := w.reg[wsID]
	var n *layoutNode
	if st != nil {
		n = st.layout
	}
	w.mu.Unlock()
	if st == nil {
		return "", "", fmt.Errorf("%w: %s", errNoWorkspace, wsID)
	}
	if target == "" {
		t, d := autoTarget(n)
		target, dir = t, d
	} else if !layoutHas(n, target) {
		return "", "", fmt.Errorf("%w: %s", errNoPane, target)
	}
	if !validSplitDir(dir) {
		return "", "", fmt.Errorf("%w: %q", errBadDir, dir)
	}
	if err := w.checkSplit(target, dir); err != nil {
		return "", "", err
	}
	return target, dir, nil
}

// placePane は recomputeMu を持って呼ぶ。生きている欄 id を、planSplit が決めた場所に足す。
func (w *wsManager) placePane(wsID, target, dir, id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if st := w.reg[wsID]; st != nil {
		if n, ok := layoutSplit(st.layout, target, id, dir); ok {
			st.layout = n
		}
	}
}

// ---- 境界を動かす（layout.resize）----
//
// 境界（割合を持つ節）は、B 側の左上の葉の欄 id（layoutFirstPane(n.B)）で指す。木のどの葉も、ちょうど 1 つの節の
// 「B 側の左上」になる（根の左上の葉は除く）ので、節の指し方として一意で、ほかの欄を分けても変わらない。

const (
	// 欄の大きさが分からないとき（ターミナルでない欄だけの境界など）の、割合の下限と上限
	fallbackRatioMin = 0.05
	fallbackRatioMax = 0.95
	// 割合を保存する細かさ（0.1%）
	ratioStep = 1000
)

var (
	errBadRatio = errors.New("invalid ratio")
	errNoBorder = errors.New("no such border")
)

// layoutFirstPane は n の左上の葉の欄 id。
func layoutFirstPane(n *layoutNode) string {
	for n != nil && !n.isLeaf() {
		n = n.A
	}
	if n == nil {
		return ""
	}
	return n.Pane
}

// layoutFindBorder は B 側の左上の葉が key である節。無ければ nil。
func layoutFindBorder(n *layoutNode, key string) *layoutNode {
	if n == nil || n.isLeaf() {
		return nil
	}
	if layoutFirstPane(n.B) == key {
		return n
	}
	if f := layoutFindBorder(n.A, key); f != nil {
		return f
	}
	return layoutFindBorder(n.B, key)
}

// layoutSetRatio は key の節の割合を ratio にした木（変えるところだけ新しく作る）。節が無ければ ok == false。
func layoutSetRatio(n *layoutNode, key string, ratio float64) (*layoutNode, bool) {
	if n == nil || n.isLeaf() {
		return n, false
	}
	if layoutFirstPane(n.B) == key {
		return &layoutNode{Dir: n.Dir, Ratio: ratio, A: n.A, B: n.B}, true
	}
	if a, ok := layoutSetRatio(n.A, key, ratio); ok {
		return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: a, B: n.B}, true
	}
	if b, ok := layoutSetRatio(n.B, key, ratio); ok {
		return &layoutNode{Dir: n.Dir, Ratio: n.Ratio, A: n.A, B: b}, true
	}
	return n, false
}

// layoutExtent は n が向き（horiz: 列、そうでなければ行）に占める大きさ（端末のセル）。size は欄の列と行（分からなければ ok == false）。
// 同じ向きの分割は A と B の和、直交する向きの分割は A の大きさ。
func layoutExtent(n *layoutNode, horiz bool, size func(id string) (cols, rows int, ok bool)) (int, bool) {
	if n == nil {
		return 0, false
	}
	if n.isLeaf() {
		c, r, ok := size(n.Pane)
		if !ok {
			return 0, false
		}
		if horiz {
			return c, true
		}
		return r, true
	}
	a, ok := layoutExtent(n.A, horiz, size)
	if !ok {
		return 0, false
	}
	if (n.Dir == dirRight) != horiz {
		return a, true
	}
	b, ok := layoutExtent(n.B, horiz, size)
	if !ok {
		return 0, false
	}
	return a + b, true
}

// layoutMinExtent は n が向きに対して最低限ほしい大きさ（端末のセル）。同じ向きの分割は和、直交する向きは大きいほう。
func layoutMinExtent(n *layoutNode, horiz bool) int {
	if n == nil {
		return 0
	}
	if n.isLeaf() {
		if horiz {
			return minSplitCols
		}
		return minSplitRows
	}
	a, b := layoutMinExtent(n.A, horiz), layoutMinExtent(n.B, horiz)
	if (n.Dir == dirRight) == horiz {
		return a + b
	}
	return max(a, b)
}

// ratioBounds は節 n の割合の下限と上限。両側が最小の大きさ以上に残る範囲（大きさが分からなければ fallback）。
// すでに両側を満たせないほど小さければ ok == false。
func ratioBounds(n *layoutNode, size func(id string) (cols, rows int, ok bool)) (lo, hi float64, ok bool) {
	horiz := n.Dir == dirRight
	a, okA := layoutExtent(n.A, horiz, size)
	b, okB := layoutExtent(n.B, horiz, size)
	if !okA || !okB || a+b <= 0 {
		return fallbackRatioMin, fallbackRatioMax, true
	}
	s := float64(a + b)
	lo = float64(layoutMinExtent(n.A, horiz)) / s
	hi = 1 - float64(layoutMinExtent(n.B, horiz))/s
	return lo, hi, lo <= hi
}

// clampRatio は ratio を [lo, hi] に収め、0.1% の細かさに丸める（丸めても範囲の中に残す）。
func clampRatio(ratio, lo, hi float64) float64 {
	r := min(max(ratio, lo), hi)
	q := math.Round(r*ratioStep) / ratioStep
	if q < lo {
		q = math.Ceil(lo*ratioStep) / ratioStep
	}
	if q > hi {
		q = math.Floor(hi*ratioStep) / ratioStep
	}
	return q
}

// paneSize は欄 id のターミナルの列と行。ターミナルでない欄は ok == false。
func (w *wsManager) paneSize(id string) (cols, rows int, ok bool) {
	t, err := w.srv.terms.get(id)
	if err != nil {
		return 0, 0, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cols, t.rows, true
}

// resizeBorder は layout.resize：wsID のワークスペースで、B 側の左上の欄が key の境界の割合を ratio にする。
// 両側が最小の大きさ（minSplitCols 列・minSplitRows 行）を下回る分は収める。実際に使った割合を返す。
func (w *wsManager) resizeBorder(wsID, key string, ratio float64) (float64, error) {
	if math.IsNaN(ratio) || ratio <= 0 || ratio >= 1 {
		return 0, fmt.Errorf("%w: %v", errBadRatio, ratio)
	}
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	st := w.reg[wsID]
	var n *layoutNode
	if st != nil {
		n = st.layout
	}
	w.mu.Unlock()
	if st == nil {
		return 0, fmt.Errorf("%w: %s", errNoWorkspace, wsID)
	}
	node := layoutFindBorder(n, key)
	if node == nil {
		return 0, fmt.Errorf("%w: %s", errNoBorder, key)
	}
	lo, hi, ok := ratioBounds(node, w.paneSize)
	if !ok {
		return 0, fmt.Errorf("%w: the panes are too small to move the border", errTooSmall)
	}
	ratio = clampRatio(ratio, lo, hi)
	w.mu.Lock()
	if cur := w.reg[wsID]; cur != nil {
		if next, ok := layoutSetRatio(cur.layout, key, ratio); ok {
			cur.layout = next
		}
	}
	w.mu.Unlock()
	w.recomputeLocked()
	return ratio, nil
}

// swapPanes は layout.swap：wsID のワークスペースで、欄 pane と欄 other の場所を入れ替える。入れ替えるのは
// 木の中の場所だけで、欄の役目（プライマリなど）は変わらない。どちらかが木に無ければ errNoPane。
func (w *wsManager) swapPanes(wsID, pane, other string) error {
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	st := w.reg[wsID]
	if st == nil {
		w.mu.Unlock()
		return fmt.Errorf("%w: %s", errNoWorkspace, wsID)
	}
	next, err := layoutSwap(st.layout, pane, other)
	if err != nil {
		w.mu.Unlock()
		return err
	}
	st.layout = next
	w.mu.Unlock()
	w.recomputeLocked()
	return nil
}
