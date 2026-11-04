package server

// screen.update の中身（前に送った画面との差）を作る。
//
// 領域（focus・files・status・cmdline・overlay）は変わったものだけを付ける。ファイルの欄は、ペインの並びが
// 変わったか、どれかのペインが変わったときに付け、panes には今のペインを全部並べる（並びで、消えたペインが
// 分かる）。前からあるペインは id と変わった項目だけ、新しいペインは全部の項目を持つ。行（lines.rows）は
// ビューポートの中で上から何行目かをキーにし、変わった行だけを送る。スクロールした（先頭の行や横の位置、
// 幅が変わった）ときは全部の行を送る。

import (
	"reflect"
	"strconv"

	"github.com/mm1995tk/shijimi-editor/core/screen"
)

// diffScreen は prev から next への差。prev が nil なら購読している領域を全部付ける。差が無ければ nil。
func diffScreen(prev, next *screen.Screen, regions map[screen.Region]bool) map[string]any {
	full := prev == nil
	if full {
		prev = &screen.Screen{}
	}
	out := map[string]any{}
	if full || prev.Focus != next.Focus {
		out["focus"] = next.Focus
	}
	if regions[screen.RegionFiles] {
		if f := diffFiles(prev.Files, next.Files, full); f != nil {
			out["files"] = f
		}
	}
	if regions[screen.RegionStatus] && (full || !reflect.DeepEqual(prev.Status, next.Status)) {
		out["status"] = next.Status
	}
	if regions[screen.RegionCmdline] && (full || !reflect.DeepEqual(prev.Cmdline, next.Cmdline)) {
		out["cmdline"] = next.Cmdline // 閉じたら null
	}
	if regions[screen.RegionOverlay] && (full || !reflect.DeepEqual(prev.Overlay, next.Overlay)) {
		ov := next.Overlay
		if ov == nil {
			ov = []screen.Overlay{}
		}
		out["overlay"] = ov
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// diffFiles はファイルの欄の差。差が無ければ nil。
func diffFiles(prev, next *screen.Files, full bool) map[string]any {
	if next == nil {
		next = &screen.Files{}
	}
	if prev == nil {
		prev, full = &screen.Files{}, true
	}
	old := map[string]*screen.Pane{}
	for i := range prev.Panes {
		old[prev.Panes[i].ID] = &prev.Panes[i]
	}
	changed := full || len(prev.Panes) != len(next.Panes)
	panes := make([]map[string]any, 0, len(next.Panes))
	for i := range next.Panes {
		np := &next.Panes[i]
		if !changed && prev.Panes[i].ID != np.ID {
			changed = true
		}
		d := diffPane(old[np.ID], np)
		if len(d) > 1 {
			changed = true
		}
		panes = append(panes, d)
	}
	out := map[string]any{}
	if full || prev.Active != next.Active {
		out["active"] = next.Active
	}
	if !changed && len(out) == 0 {
		return nil
	}
	out["panes"] = panes
	return out
}

// diffPane はペインの差。id はいつも付く。prev が nil なら全部の項目を付ける。
func diffPane(prev, next *screen.Pane) map[string]any {
	full := prev == nil
	if full {
		prev = &screen.Pane{}
	}
	out := map[string]any{"id": next.ID}
	put := func(key string, a, b any) {
		if full || !reflect.DeepEqual(a, b) {
			out[key] = b
		}
	}
	put("kind", prev.Kind, next.Kind)
	put("title", prev.Title, next.Title)
	put("viewport", prev.Viewport, next.Viewport)
	put("curLine", prev.CurLine, next.CurLine)
	put("cursors", prev.Cursors, next.Cursors)
	put("selections", prev.Selections, next.Selections)
	put("image", prev.Image, next.Image)
	put("caption", prev.Caption, next.Caption)
	put("diff", prev.Diff, next.Diff)
	put("preview", prev.Preview, next.Preview)

	scrolled := full || prev.Kind != next.Kind ||
		prev.Viewport.Top != next.Viewport.Top || prev.Viewport.Left != next.Viewport.Left ||
		prev.Viewport.Cols != next.Viewport.Cols ||
		diffTop(prev) != diffTop(next)
	rows := map[string]screen.Line{}
	for i, l := range next.Lines {
		if scrolled || i >= len(prev.Lines) || !reflect.DeepEqual(prev.Lines[i], l) {
			rows[strconv.Itoa(i)] = l
		}
	}
	if full || len(rows) > 0 || len(prev.Lines) != len(next.Lines) {
		out["lines"] = map[string]any{"rows": rows, "count": len(next.Lines)}
	}
	return out
}

// diffTop は差分とプレビューのペインの、表示行での先頭（Viewport.Top はバッファの行なので別に見る）。
func diffTop(p *screen.Pane) int {
	switch {
	case p.Diff != nil:
		return p.Diff.Top
	case p.Preview != nil:
		return p.Preview.Top
	}
	return -1
}
