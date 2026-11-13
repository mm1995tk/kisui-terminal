package server

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

func TestLayoutSplitAndPrune(t *testing.T) {
	n := leaf("a")
	n, ok := layoutSplit(n, "a", "b", dirRight)
	if !ok {
		t.Fatal("split a")
	}
	n, _ = layoutSplit(n, "b", "c", dirDown)
	if got := layoutPanes(n); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("panes: %v", got)
	}
	if _, ok := layoutSplit(n, "zz", "d", dirRight); ok {
		t.Error("split of a missing pane")
	}
	// b を閉じると c が b の場所を埋める
	m := layoutPrune(n, map[string]bool{"a": true, "c": true}, map[string]bool{})
	if m.Dir != dirRight || m.A.Pane != "a" || m.B.Pane != "c" {
		t.Errorf("after close: %+v", m)
	}
	if !validLayout(n) || validLayout(&layoutNode{Dir: "right"}) || validLayout(nil) {
		t.Error("validLayout")
	}
}

func TestLayoutReconcile(t *testing.T) {
	// 木が無ければプライマリだけ。増えた欄は交互の向きで足す。上限は無い。
	live := []string{"p", "t1", "t2", "t3", "t4", "t5", "t6", "t7"}
	n := layoutReconcile(nil, live)
	if got := layoutPanes(n); !reflect.DeepEqual(got, live) {
		t.Fatalf("panes: %v", got)
	}
	if n.Dir != dirRight || n.B.Dir != dirDown || n.B.B.Dir != dirRight {
		t.Errorf("auto directions: %+v", n)
	}
	// 同じ欄なら同じ木のまま
	if m := layoutReconcile(n, live); m != n {
		t.Error("reconcile of an unchanged tree allocated a new one")
	}
	if m := layoutReconcile(n, live[:1]); !m.isLeaf() || m.Pane != "p" {
		t.Errorf("only primary: %+v", m)
	}
}

func TestLayoutBorderKeyAndRatio(t *testing.T) {
	n := layoutReconcile(nil, []string{"p", "t1", "t2"}) // p | (t1 / t2)
	if f := layoutFindBorder(n, "t1"); f != n {
		t.Fatalf("root border: %+v", f)
	}
	if f := layoutFindBorder(n, "t2"); f != n.B {
		t.Fatalf("inner border: %+v", f)
	}
	if layoutFindBorder(n, "p") != nil || layoutFindBorder(n, "zz") != nil {
		t.Error("p is nobody's B side")
	}
	m, ok := layoutSetRatio(n, "t2", 0.3)
	if !ok || m.B.Ratio != 0.3 || m.Ratio != 0.5 || n.B.Ratio != 0.5 {
		t.Errorf("set ratio: %+v (old tree must stay)", m)
	}
	// 欄を足しても、既存の境界の指し方は変わらない
	m2, _ := layoutSplit(m, "t2", "t3", dirRight)
	if f := layoutFindBorder(m2, "t2"); f == nil || f.Ratio != 0.3 {
		t.Errorf("key after split: %+v", f)
	}
}

func TestRatioBounds(t *testing.T) {
	sizes := map[string][2]int{"a": {80, 24}, "b": {80, 24}}
	size := func(id string) (int, int, bool) { s, ok := sizes[id]; return s[0], s[1], ok }
	n := &layoutNode{Dir: dirRight, Ratio: 0.5, A: leaf("a"), B: leaf("b")}
	lo, hi, ok := ratioBounds(n, size)
	if !ok || lo != 20.0/160 || hi != 1-20.0/160 {
		t.Errorf("bounds: %v %v %v", lo, hi, ok)
	}
	// 下に分ける境界は行（minSplitRows）で見る
	n = &layoutNode{Dir: dirDown, Ratio: 0.5, A: leaf("a"), B: leaf("b")}
	lo, hi, _ = ratioBounds(n, size)
	if lo != 5.0/48 || hi != 1-5.0/48 {
		t.Errorf("rows: %v %v", lo, hi)
	}
	// 大きさが分からない欄は fallback
	n = &layoutNode{Dir: dirRight, Ratio: 0.5, A: leaf("a"), B: leaf("x")}
	if lo, hi, _ := ratioBounds(n, size); lo != fallbackRatioMin || hi != fallbackRatioMax {
		t.Errorf("fallback: %v %v", lo, hi)
	}
	// 両側が入らないほど小さい
	sizes["a"], sizes["b"] = [2]int{15, 24}, [2]int{15, 24}
	n = &layoutNode{Dir: dirRight, Ratio: 0.5, A: leaf("a"), B: leaf("b")}
	if _, _, ok := ratioBounds(n, size); ok {
		t.Error("too small must not be ok")
	}
	if r := clampRatio(0.12345, 0.1, 0.9); r != 0.123 {
		t.Errorf("round: %v", r)
	}
	if r := clampRatio(0.0, 0.1234, 0.9); r != 0.124 {
		t.Errorf("clamp+round keeps inside: %v", r)
	}
}

// layout.resize は境界の割合を serve に持たせ、workspace.list に出す。最小の大きさを下回る位置には動かさない。
func TestLayoutResizeRPC(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	wsID, primary := createWS(t, c)
	id := createTerm(t, c, map[string]any{"workspaceId": wsID, "split": map[string]any{"target": primary, "dir": "right"}})
	var res struct{ Ratio float64 }
	if err := c.Call(ctx, "layout.resize", map[string]any{"workspaceId": wsID, "pane": id, "ratio": 0.3333}, &res); err != nil {
		t.Fatal(err)
	}
	if res.Ratio != 0.333 {
		t.Errorf("ratio: %v", res.Ratio)
	}
	if got := listWS(t, c).Workspaces[0].Layout; got.Ratio != 0.333 {
		t.Errorf("listed ratio: %+v", got)
	}
	// 欄は 80 列。左を 20 列より狭く、右を 20 列より狭くはできない
	if err := c.Call(ctx, "layout.resize", map[string]any{"workspaceId": wsID, "pane": id, "ratio": 0.01}, &res); err != nil {
		t.Fatal(err)
	}
	if res.Ratio < 0.12 || res.Ratio > 0.13 {
		t.Errorf("clamped low: %v", res.Ratio)
	}
	if err := c.Call(ctx, "layout.resize", map[string]any{"workspaceId": wsID, "pane": id, "ratio": 0.99}, &res); err != nil {
		t.Fatal(err)
	}
	if res.Ratio < 0.87 || res.Ratio > 0.88 {
		t.Errorf("clamped high: %v", res.Ratio)
	}
	for name, p := range map[string]map[string]any{
		"no workspace": {"workspaceId": "nope", "pane": id, "ratio": 0.5},
		"no border":    {"workspaceId": wsID, "pane": primary, "ratio": 0.5},
	} {
		if err := c.Call(ctx, "layout.resize", p, nil); !isCode(err, rpc.CodeNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for _, r := range []any{0, 1, -1, "x", nil} {
		if err := c.Call(ctx, "layout.resize", map[string]any{"workspaceId": wsID, "pane": id, "ratio": r}, nil); !isCode(err, rpc.CodeInvalidParams) {
			t.Errorf("ratio %v: %v", r, err)
		}
	}
}

// 入れ子：B が下に分けた節なら、右の境界の B の最小は 20 列のまま（直交する向きは大きいほう）。
func TestLayoutMinExtentNested(t *testing.T) {
	n := &layoutNode{Dir: dirRight, Ratio: 0.5, A: leaf("a"), B: &layoutNode{Dir: dirDown, Ratio: 0.5, A: leaf("b"), B: leaf("c")}}
	if got := layoutMinExtent(n.B, true); got != minSplitCols {
		t.Errorf("cols of a down split: %d", got)
	}
	if got := layoutMinExtent(n.B, false); got != 2*minSplitRows {
		t.Errorf("rows of a down split: %d", got)
	}
}

// 左と上は、節の向きは right・down のまま、新しい欄を A に、今の欄を B にして表す。
func TestLayoutSplitLeftUp(t *testing.T) {
	n, ok := layoutSplit(leaf("a"), "a", "b", dirLeft)
	if !ok || n.Dir != dirRight || n.A.Pane != "b" || n.B.Pane != "a" {
		t.Fatalf("left: %+v", n)
	}
	n, ok = layoutSplit(n, "a", "c", dirUp)
	if !ok || n.Dir != dirRight || n.A.Pane != "b" || n.B.Dir != dirDown || n.B.A.Pane != "c" || n.B.B.Pane != "a" {
		t.Fatalf("up: %+v", n)
	}
	if got := layoutPanes(n); !reflect.DeepEqual(got, []string{"b", "c", "a"}) {
		t.Errorf("panes: %v", got)
	}
	if !validLayout(n) {
		t.Error("validLayout")
	}
	// 境界は B 側の左上の葉で指す。左に分けた境界は、今の欄（B）で指す
	if layoutFindBorder(n, "a") == nil || layoutFindBorder(n, "c") == nil || layoutFindBorder(n, "b") != nil {
		t.Error("border keys")
	}
	for _, d := range []string{dirLeft, dirUp, dirRight, dirDown} {
		if !validSplitDir(d) {
			t.Errorf("validSplitDir(%q)", d)
		}
	}
	if validSplitDir("") || validSplitDir("diagonal") {
		t.Error("validSplitDir accepts a bad direction")
	}
	// 4 つ以外の向きは、木に入れない
	if m, ok := layoutSplit(leaf("a"), "a", "b", "diagonal"); ok || !m.isLeaf() {
		t.Errorf("a bad direction changed the tree: %+v", m)
	}
}

// term.create に "left" を渡すと新しい欄が左（A）に入り、境界を動かせる。向きが正しくなければ断る。
func TestSplitLeftUpRPC(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	wsID, primary := createWS(t, c)
	id := createTerm(t, c, map[string]any{"workspaceId": wsID, "split": map[string]any{"target": primary, "dir": "left"}})
	l := listWS(t, c).Workspaces[0].Layout
	if l.Dir != "right" || l.A.Pane != id || l.B.Pane != primary {
		t.Fatalf("layout: %+v", l)
	}
	// 境界は B 側の左上の葉（今の欄）で指す
	var res struct{ Ratio float64 }
	if err := c.Call(ctx, "layout.resize", map[string]any{"workspaceId": wsID, "pane": primary, "ratio": 0.4}, &res); err != nil {
		t.Fatal(err)
	}
	if got := listWS(t, c).Workspaces[0].Layout; got.Ratio != 0.4 {
		t.Errorf("listed ratio: %+v", got)
	}
	up := createTerm(t, c, map[string]any{"workspaceId": wsID, "split": map[string]any{"target": primary, "dir": "up"}})
	l = listWS(t, c).Workspaces[0].Layout
	if l.B.Dir != "down" || l.B.A.Pane != up || l.B.B.Pane != primary {
		t.Fatalf("layout after up: %+v", l)
	}
	err := c.Call(ctx, "term.create", map[string]any{"workspaceId": wsID, "split": map[string]any{"target": primary, "dir": "diagonal"}}, nil)
	if !isCode(err, rpc.CodeInvalidParams) {
		t.Errorf("bad dir: %v", err)
	}
}

// 入れ替えは、2 つの葉の場所だけを替える。節の向きと割合は場所のまま。
func TestLayoutSwap(t *testing.T) {
	n := &layoutNode{Dir: dirRight, Ratio: 0.3, A: leaf("a"), B: &layoutNode{Dir: dirDown, Ratio: 0.6, A: leaf("b"), B: leaf("c")}}
	m, err := layoutSwap(n, "a", "c")
	if err != nil {
		t.Fatal(err)
	}
	want := &layoutNode{Dir: dirRight, Ratio: 0.3, A: leaf("c"), B: &layoutNode{Dir: dirDown, Ratio: 0.6, A: leaf("b"), B: leaf("a")}}
	if !layoutEqual(m, want) {
		t.Errorf("swap: %+v", m)
	}
	// もとの木は変えない
	if n.A.Pane != "a" || n.B.B.Pane != "c" {
		t.Error("the original tree changed")
	}
	if !validLayout(m) {
		t.Error("validLayout")
	}
	// 戻せる
	if back, _ := layoutSwap(m, "c", "a"); !layoutEqual(back, n) {
		t.Errorf("swap back: %+v", back)
	}
	for name, c := range map[string]struct {
		p    [2]string
		want error
	}{"same": {[2]string{"a", "a"}, errBadSwap}, "missing": {[2]string{"a", "z"}, errNoPane}, "both missing": {[2]string{"y", "z"}, errNoPane}} {
		if m, err := layoutSwap(n, c.p[0], c.p[1]); !errors.Is(err, c.want) || m != n {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// layout.swap は serve の木で 2 つの欄の場所を替える。プライマリの役目は替わらない。木は workspace.list に出る。
func TestLayoutSwapRPC(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	wsID, primary := createWS(t, c)
	id := createTerm(t, c, map[string]any{"workspaceId": wsID, "split": map[string]any{"target": primary, "dir": "right"}})
	if err := c.Call(ctx, "layout.swap", map[string]any{"workspaceId": wsID, "pane": primary, "other": id}, nil); err != nil {
		t.Fatal(err)
	}
	ws := listWS(t, c).Workspaces[0]
	if l := ws.Layout; l.Dir != "right" || l.A.Pane != id || l.B.Pane != primary {
		t.Fatalf("layout: %+v", l)
	}
	// プライマリの役目は、場所が替わっても primary に残る
	if ws.Primary != primary {
		t.Errorf("primary: %q want %q", ws.Primary, primary)
	}
	for name, p := range map[string]map[string]any{
		"no workspace": {"workspaceId": "nope", "pane": primary, "other": id},
		"no pane":      {"workspaceId": wsID, "pane": primary, "other": "nope"},
		"no pane 2":    {"workspaceId": wsID, "pane": "nope", "other": id},
	} {
		if err := c.Call(ctx, "layout.swap", p, nil); !isCode(err, rpc.CodeNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, p := range map[string]map[string]any{
		"same":    {"workspaceId": wsID, "pane": id, "other": id},
		"missing": {"workspaceId": wsID, "pane": id},
	} {
		if err := c.Call(ctx, "layout.swap", p, nil); !isCode(err, rpc.CodeInvalidParams) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if l := listWS(t, c).Workspaces[0].Layout; l.A.Pane != id || l.B.Pane != primary {
		t.Errorf("a refused swap changed the tree: %+v", l)
	}
}
