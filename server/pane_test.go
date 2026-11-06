package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mm1995tk/shijimi-editor/core/ctl"
)

// paneDo は shj が欄を頼むところ（名乗りとは別の接続で 1 回）。
func paneDo(t *testing.T, sock string, rq ctl.PaneRequest) ctl.PaneReply {
	t.Helper()
	c, err := net.Dial("unix", filepath.Join(filepath.Dir(sock), ctl.ServePrimaryName))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	b, _ := json.Marshal(rq)
	c.Write(append(b, '\n'))
	var r ctl.PaneReply
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&r); err != nil {
		t.Fatal(err)
	}
	return r
}

// 欄を作り、出す・隠す・打つ・読む・閉じるができる。shj が終わると、その shj の欄は閉じる。
func TestPrimaryShjPanes(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	r0, hello := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	if !r0.OK {
		t.Fatalf("hello: %+v", r0)
	}
	rq := func(op string) ctl.PaneRequest { return ctl.PaneRequest{Op: op, TermID: primary, PID: 11} }

	// 名乗った shj でなければ断る。
	bad := rq("split")
	bad.PID = 12
	if r := paneDo(t, sock, bad); r.OK {
		t.Fatal("another pid must be refused")
	}

	split := rq("split")
	split.Env = []string{"PANE_X=hello"}
	r := paneDo(t, sock, split)
	if !r.OK || r.ID == "" || r.ID == primary {
		t.Fatalf("split: %+v", r)
	}
	pane := r.ID
	// workspace.changed で GUI が欄を知ってから、pane.show が届く。
	waitFor(t, "pane.show", func() bool {
		for _, m := range nt.all("pane.show") {
			if strings.Contains(string(*m), `"termId":"`+pane+`"`) && strings.Contains(string(*m), `"workspaceId":"`+id+`"`) {
				return true
			}
		}
		return false
	})
	var l struct {
		Workspaces []wsInfo `json:"workspaces"`
	}
	if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 || len(l.Workspaces[0].Terms) != 1 || l.Workspaces[0].Terms[0] != pane {
		t.Fatalf("workspace.list: %v %+v", err, l)
	}
	if r := paneDo(t, sock, ctl.PaneRequest{Op: "alive", TermID: primary, PID: 11, ID: pane}); !r.OK || !r.Alive {
		t.Fatalf("alive: %+v", r)
	}

	send := rq("send")
	send.ID, send.Text, send.Enter = pane, "echo $PANE_X-ok", true
	if r := paneDo(t, sock, send); !r.OK {
		t.Fatalf("send: %+v", r)
	}
	waitFor(t, "output of the pane", func() bool {
		tail := rq("tail")
		tail.ID, tail.N = pane, 5
		return strings.Contains(strings.Join(paneDo(t, sock, tail).Lines, "\n"), "hello-ok")
	})

	if r := paneDo(t, sock, rq("hide")); !r.OK {
		t.Fatalf("hide: %+v", r)
	}
	waitFor(t, "pane.hide", func() bool { return nt.find("pane.hide") != nil })
	show := rq("show")
	show.ID = pane
	if r := paneDo(t, sock, show); !r.OK {
		t.Fatalf("show: %+v", r)
	}

	// 作っていない欄（プライマリ）には触れない。
	send.ID = primary
	if r := paneDo(t, sock, send); r.OK {
		t.Fatal("the primary is not a pane of the shj")
	}

	cl := rq("close")
	cl.ID = pane
	if r := paneDo(t, sock, cl); !r.OK {
		t.Fatalf("close: %+v", r)
	}
	if r := paneDo(t, sock, ctl.PaneRequest{Op: "alive", TermID: primary, PID: 11, ID: pane}); r.Alive {
		t.Fatal("a closed pane is not alive")
	}

	// shj が終わると、その shj の欄は閉じる。
	split2 := paneDo(t, sock, rq("split"))
	if !split2.OK {
		t.Fatalf("split again: %+v", split2)
	}
	hello.Close()
	waitFor(t, "the pane closes with its shj", func() bool { _, err := srv.terms.get(split2.ID); return err != nil })
}
