package server

import (
	"context"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// outOfReach は、届かないペインを指したときの断りか。
func outOfReach(r panecmd.Reply) bool {
	return !r.OK && strings.Contains(r.Error, "among the panes this pane opened")
}

func paneIDs(r panecmd.Reply) []string {
	var ids []string
	for _, p := range r.Panes {
		ids = append(ids, p.ID)
	}
	return ids
}

// 既定では、ペインの中のコマンドは、自分と、自分が作ったペインの先にだけ届く。
func TestPaneReachOwn(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, _ := termClient(t, sock)
	_, p1 := createWS(t, c) // 人が窓で開いたペイン
	_, p2 := createWS(t, c) // 人が窓で開いた、別のペイン
	do := func(pane string) func(panecmd.Request) panecmd.Reply {
		tok := termToken(t, srv, pane)
		return func(rq panecmd.Request) panecmd.Reply {
			rq.Pane, rq.Token = pane, tok
			return paneCmdDo(t, sock, rq)
		}
	}
	do1, do2 := do(p1), do(p2)
	split := func(d func(panecmd.Request) panecmd.Reply, name string) string {
		t.Helper()
		r := d(panecmd.Request{Cmd: "split", Dir: "right", Name: name, Argv: []string{"/bin/sh"}})
		if !r.OK {
			t.Fatalf("split %s: %+v", name, r)
		}
		return r.ID
	}
	worker := split(do1, "worker") // p1 が作ったペイン
	doWorker := do(worker)
	grand := split(doWorker, "grand") // worker が作ったペイン

	// 作った側は、作ったペインと、その先に届く
	for _, to := range []string{"worker", worker, "grand", grand, p1} {
		if r := do1(panecmd.Request{Cmd: "read", To: to}); !r.OK {
			t.Errorf("p1 reads %s: %+v", to, r)
		}
	}
	if r := do1(panecmd.Request{Cmd: "send", To: "grand", Text: "true"}); !r.OK || r.ID != grand {
		t.Errorf("p1 sends to grand: %+v", r)
	}
	if r := doWorker(panecmd.Request{Cmd: "keys", To: "grand", Keys: []string{"enter"}}); !r.OK || r.ID != grand {
		t.Errorf("worker sends keys to grand: %+v", r)
	}

	// 作られた側から、作った側には届かない。きょうだいでも、人が開いた別のペインでも同じ。無い名前も同じ文で断る
	for _, c := range []struct {
		who string
		do  func(panecmd.Request) panecmd.Reply
		to  string
	}{
		{"worker", doWorker, p1},
		{"grand", do(grand), "worker"},
		{"p2", do2, "worker"},
		{"p2", do2, worker},
		{"p2", do2, p1},
		{"p1", do1, p2},
		{"p1", do1, "nope"},
	} {
		for _, rq := range []panecmd.Request{
			{Cmd: "read", To: c.to},
			{Cmd: "send", To: c.to, Text: "echo no"},
			{Cmd: "keys", To: c.to, Keys: []string{"enter"}},
			{Cmd: "close", To: c.to},
		} {
			if r := c.do(rq); !outOfReach(r) {
				t.Errorf("%s %s %s: %+v", c.who, rq.Cmd, c.to, r)
			}
		}
	}
	// 断った close で、ペインは閉じていない
	if _, err := srv.terms.get(worker); err != nil {
		t.Fatalf("worker was closed: %v", err)
	}

	// 一覧は、自分と届くペインだけ
	for _, c := range []struct {
		who  string
		do   func(panecmd.Request) panecmd.Reply
		want string
	}{
		{"p1", do1, p1 + " " + worker + " " + grand},
		{"worker", doWorker, worker + " " + grand},
		{"grand", do(grand), grand},
		{"p2", do2, p2},
	} {
		r := c.do(panecmd.Request{Cmd: "list"})
		if got := strings.Join(paneIDs(r), " "); !r.OK || got != c.want {
			t.Errorf("list of %s: %q, want %q", c.who, got, c.want)
		}
	}

	// 途中のペインが閉じても、その先には届く
	if r := do1(panecmd.Request{Cmd: "close", To: "worker"}); !r.OK {
		t.Fatalf("p1 closes worker: %+v", r)
	}
	if r := do1(panecmd.Request{Cmd: "read", To: "grand"}); !r.OK {
		t.Errorf("p1 reads grand after worker closed: %+v", r)
	}
}

// [server] pane_reach = "all" なら、このマシンの全部のペインに届く。設定は使うたびに読む。
func TestPaneReachAll(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	all := false
	srv, sock := startFastWith(t, func(o *Options) { o.PaneReachAll = func() bool { return all } })
	c, _ := termClient(t, sock)
	_, p1 := createWS(t, c)
	_, p2 := createWS(t, c)
	tok := termToken(t, srv, p1)
	do1 := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = p1, tok
		return paneCmdDo(t, sock, rq)
	}
	if r := do1(panecmd.Request{Cmd: "read", To: p2}); !outOfReach(r) {
		t.Fatalf("own: %+v", r)
	}
	all = true
	if r := do1(panecmd.Request{Cmd: "read", To: p2}); !r.OK || r.ID != p2 {
		t.Fatalf("all: %+v", r)
	}
	if r := do1(panecmd.Request{Cmd: "list"}); len(r.Panes) != 2 {
		t.Fatalf("list with all: %+v", r)
	}
	// 無い名前は、今まで通りの文
	if r := do1(panecmd.Request{Cmd: "read", To: "nope"}); r.OK || outOfReach(r) {
		t.Fatalf("nope with all: %+v", r)
	}
	all = false
	if r := do1(panecmd.Request{Cmd: "read", To: p2}); !outOfReach(r) {
		t.Fatalf("own again: %+v", r)
	}
}

// 別のマシンのペインから中継された頼み（pane.run）と、窓が作るタブ（workspace.create の ancestry）。
func TestPaneReachAcrossMachines(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, _ := termClient(t, sock)
	_, human := createWS(t, c)
	// 別のマシン（serverId が other）のペイン t7 が kisui pane open --machine で作らせたタブ
	var made struct {
		TermID string `json:"termId"`
	}
	err := c.Call(context.Background(), "workspace.create", map[string]any{
		"name": "remote-made", "argv": []string{"/bin/sh"},
		"ancestry": []map[string]any{{"server": "other", "pane": "t3"}, {"server": "other", "pane": "t7"}},
	}, &made)
	if err != nil || made.TermID == "" {
		t.Fatalf("workspace.create: %v %+v", err, made)
	}
	run := func(from map[string]any, rq map[string]any) panecmd.Reply {
		t.Helper()
		if from != nil {
			rq["from"] = from
		}
		var r panecmd.Reply
		if err := c.Call(context.Background(), "pane.run", rq, &r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	other := func(pane string) map[string]any { return map[string]any{"server": "other", "pane": pane} }

	// 作ったペインと、その作り手は届く
	for _, pane := range []string{"t7", "t3"} {
		if r := run(other(pane), map[string]any{"cmd": "read", "to": "remote-made"}); !r.OK || r.ID != made.TermID {
			t.Errorf("%s reads: %+v", pane, r)
		}
		if r := run(other(pane), map[string]any{"cmd": "list"}); len(r.Panes) != 1 || r.Panes[0].ID != made.TermID || r.Panes[0].Self {
			t.Errorf("%s lists: %+v", pane, r)
		}
	}
	// 人が開いたペインには届かない。別のペイン・別のマシン・名乗らない頼み（古い窓）は、どこにも届かない
	if r := run(other("t7"), map[string]any{"cmd": "send", "to": human, "text": "echo no"}); !outOfReach(r) {
		t.Errorf("t7 sends to the human pane: %+v", r)
	}
	for _, from := range []map[string]any{
		other("t8"),
		{"server": "another", "pane": "t7"},
		{"pane": "t7"}, // この serve の t7 ではない
		nil,
	} {
		for _, to := range []string{"remote-made", human} {
			if r := run(from, map[string]any{"cmd": "read", "to": to}); !outOfReach(r) {
				t.Errorf("%v reads %s: %+v", from, to, r)
			}
		}
		if r := run(from, map[string]any{"cmd": "list"}); !r.OK || len(r.Panes) != 0 {
			t.Errorf("%v lists: %+v", from, r)
		}
	}

	// この serve の serverId を付けた名乗りは、この serve のペインとして見る（自分のマシンを --machine で指したとき）
	tok := termToken(t, srv, human)
	r := paneCmdDo(t, sock, panecmd.Request{Cmd: "split", Dir: "right", Name: "mine", Argv: []string{"/bin/sh"}, Pane: human, Token: tok})
	if !r.OK {
		t.Fatalf("split: %+v", r)
	}
	self := map[string]any{"server": srv.ServerID(), "pane": human}
	if r := run(self, map[string]any{"cmd": "read", "to": "mine"}); !r.OK {
		t.Errorf("own machine through the window: %+v", r)
	}
	if r := run(self, map[string]any{"cmd": "read", "to": "remote-made"}); !outOfReach(r) {
		t.Errorf("own machine reads a pane it did not open: %+v", r)
	}
	// 作ったペインが、さらにこの serve でペインを作ると、別のマシンの作り手からも届く
	tokMade := termToken(t, srv, made.TermID)
	r = paneCmdDo(t, sock, panecmd.Request{Cmd: "split", Dir: "right", Name: "deeper", Argv: []string{"/bin/sh"}, Pane: made.TermID, Token: tokMade})
	if !r.OK {
		t.Fatalf("split from the remote-made pane: %+v", r)
	}
	if r := run(other("t7"), map[string]any{"cmd": "read", "to": "deeper"}); !r.OK {
		t.Errorf("t7 reads deeper: %+v", r)
	}
}
