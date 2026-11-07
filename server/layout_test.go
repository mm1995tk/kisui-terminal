package server

import (
	"reflect"
	"testing"
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
