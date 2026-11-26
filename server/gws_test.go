package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// gws.set で窓が知らせた窓のワークスペース（id と名前）は、kisui pane list（このマシンの list と、中継の pane.run）に出る。
// 知らせは丸ごとの置き換えで、載っていないタブの対応は消える。保存して、止めたあとの次の起動でも出る（窓がつながる前でも）。
func TestGwsSetShownInPaneListAndRestored(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	state := filepath.Join(t.TempDir(), "workspaces.json")
	withState := func(o *Options) { o.StatePath, o.PaneReachAll = state, func() bool { return true } }
	srv1, sock1 := startFastWith(t, withState)
	c1, _ := termClient(t, sock1)
	ctx := context.Background()
	a, ta := createWS(t, c1)
	b, tb := createWS(t, c1)

	var hello HelloResult
	if err := c1.Call(ctx, "session.hello", map[string]any{"protocol": Protocol, "client": map[string]any{"name": "t"}}, &hello); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(hello.Capabilities, CapGwsSet) {
		t.Fatalf("capabilities: %v", hello.Capabilities)
	}

	set := func(c *rpc.Conn, tabs ...map[string]any) error {
		if tabs == nil {
			tabs = []map[string]any{}
		}
		return c.Call(ctx, "gws.set", map[string]any{"tabs": tabs}, nil)
	}
	byID := func(panes []panecmd.PaneInfo) map[string]panecmd.PaneInfo {
		m := map[string]panecmd.PaneInfo{}
		for _, p := range panes {
			m[p.ID] = p
		}
		return m
	}
	// 知らされる前は空
	if p := byID(srv1.paneList(paneOrigin{}, ""))[ta]; p.Workspace != "" || p.WorkspaceName != "" {
		t.Errorf("before gws.set: %+v", p)
	}
	if err := set(c1,
		map[string]any{"workspaceId": a, "id": "gaaaaaaaaaa", "name": "作業用"},
		map[string]any{"workspaceId": b, "id": "gbbbbbbbbbb", "name": "ws2"},
		map[string]any{"workspaceId": "wgone", "id": "gcccccccccc", "name": "ws3"}, // もう無いタブの分は捨てる
	); err != nil {
		t.Fatal(err)
	}
	got := byID(srv1.paneList(paneOrigin{}, ""))
	if p := got[ta]; p.Workspace != "gaaaaaaaaaa" || p.WorkspaceName != "作業用" || p.Tab != a {
		t.Errorf("pane of a: %+v", p)
	}
	if p := got[tb]; p.Workspace != "gbbbbbbbbbb" || p.WorkspaceName != "ws2" {
		t.Errorf("pane of b: %+v", p)
	}
	// 別のマシンからの中継（pane.run の list）でも出る
	var r panecmd.Reply
	if err := c1.Call(ctx, "pane.run", map[string]any{"cmd": "list"}, &r); err != nil {
		t.Fatal(err)
	}
	if p := byID(r.Panes)[ta]; p.Workspace != "gaaaaaaaaaa" || p.WorkspaceName != "作業用" {
		t.Errorf("pane.run list: %+v", p)
	}
	// workspaceId の無い知らせは、何も変えずに断る
	var re *rpc.Error
	if err := set(c1, map[string]any{"workspaceId": "", "id": "gaaaaaaaaaa", "name": "x"}); !errors.As(err, &re) || re.Code != rpc.CodeInvalidParams {
		t.Errorf("gws.set without a workspaceId: %v", err)
	}
	if p := byID(srv1.paneList(paneOrigin{}, ""))[ta]; p.Workspace != "gaaaaaaaaaa" {
		t.Errorf("after refused gws.set: %+v", p)
	}
	// id が使えないタブは、その 1 つだけ対応を空にして、残りは受ける。長すぎる名前は切り、制御文字は空白に替える
	// （名前の決まりは窓が持つ。丸ごと断ると、1 つのために、このマシンのほかのタブのワークスペースも出なくなる）
	for _, badID := range []string{"", "g\naaaaaaaaa", strings.Repeat("g", maxPaneName+1)} {
		if err := set(c1,
			map[string]any{"workspaceId": a, "id": badID, "name": "x"},
			map[string]any{"workspaceId": b, "id": "gbbbbbbbbbb", "name": strings.Repeat("あ", maxPaneName+1)},
		); err != nil {
			t.Fatalf("gws.set with the id %q: %v", badID, err)
		}
		got := byID(srv1.paneList(paneOrigin{}, ""))
		if p := got[ta]; p.Workspace != "" || p.WorkspaceName != "" {
			t.Errorf("the tab of the id %q: %+v", badID, p)
		}
		if p := got[tb]; p.Workspace != "gbbbbbbbbbb" || p.WorkspaceName != strings.Repeat("あ", maxPaneName) {
			t.Errorf("the other tab, beside the id %q: %+v", badID, p)
		}
	}
	if err := set(c1, map[string]any{"workspaceId": a, "id": "gaaaaaaaaaa", "name": "a\nb"}); err != nil {
		t.Fatal(err)
	}
	if p := byID(srv1.paneList(paneOrigin{}, ""))[ta]; p.WorkspaceName != "a b" {
		t.Errorf("a control character in the name: %+v", p)
	}
	// 載っていないタブ（b）の対応は消える
	if err := set(c1, map[string]any{"workspaceId": a, "id": "gaaaaaaaaaa", "name": "名前を変えた"}); err != nil {
		t.Fatal(err)
	}
	got = byID(srv1.paneList(paneOrigin{}, ""))
	if p := got[ta]; p.WorkspaceName != "名前を変えた" {
		t.Errorf("renamed: %+v", p)
	}
	if p := got[tb]; p.Workspace != "" || p.WorkspaceName != "" {
		t.Errorf("b after it was left out: %+v", p)
	}
	waitFor(t, "saved", func() bool {
		l, err := loadState(state)
		return err == nil && len(l) == 2 && l[0].Gws == "gaaaaaaaaaa" && l[0].GwsName == "名前を変えた" && l[1].Gws == ""
	})
	if err := c1.Call(ctx, "server.shutdown", map[string]any{"force": true}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "stopped", func() bool { _, err := os.Stat(sock1); return err != nil })

	// 起動し直すと、窓がつながる前（gws.set の前）でも、最後に知らされたものが出る
	srv2, _ := startFastWith(t, withState)
	waitFor(t, "restored", func() bool {
		for _, p := range srv2.paneList(paneOrigin{}, "") {
			if p.Tab == a {
				return p.Workspace == "gaaaaaaaaaa" && p.WorkspaceName == "名前を変えた"
			}
		}
		return false
	})
}
