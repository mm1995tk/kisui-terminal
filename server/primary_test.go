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

// announceShj は TUI の shj が名乗るところ。返事と、つないだままの接続を返す。
func announceShj(t *testing.T, sock string, h ctl.PrimaryHello) (ctl.PrimaryReply, net.Conn) {
	t.Helper()
	c, err := net.Dial("unix", filepath.Join(filepath.Dir(sock), ctl.ServePrimaryName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	b, _ := json.Marshal(h)
	c.Write(append(b, '\n'))
	var r ctl.PrimaryReply
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&r); err != nil {
		t.Fatal(err)
	}
	return r, c
}

func primaryShjOf(t *testing.T, c interface {
	Call(context.Context, string, any, any) error
}, id string) *primaryShj {
	t.Helper()
	var l struct {
		Workspaces []wsInfo `json:"workspaces"`
	}
	if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil {
		t.Fatal(err)
	}
	for _, x := range l.Workspaces {
		if x.ID == id {
			return x.PrimaryShj
		}
	}
	t.Fatalf("no workspace %s", id)
	return nil
}

// プライマリで名乗った shj は workspace に出て、接続が切れると消える。最初の 1 つだけが認められる。
func TestPrimaryShjIsRememberedUntilItEnds(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	if primaryShjOf(t, c, id) != nil {
		t.Fatal("no shj yet")
	}

	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	if !r.OK {
		t.Fatalf("reply: %+v", r)
	}
	if p := primaryShjOf(t, c, id); p == nil || p.Socket != "/run/a.sock" || p.PID != 11 {
		t.Fatalf("primaryShj: %+v", p)
	}
	waitFor(t, "workspace.changed with primaryShj", func() bool {
		for _, m := range nt.all("workspace.changed") {
			if strings.Contains(string(*m), `"primaryShj":{"socket":"/run/a.sock"`) {
				return true
			}
		}
		return false
	})

	// 入れ子の shj は最初の 1 つの代わりにならない。
	if r2, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/b.sock", PID: 22}); r2.OK {
		t.Fatal("a second shj must be refused")
	}
	if p := primaryShjOf(t, c, id); p == nil || p.PID != 11 {
		t.Fatalf("still the first: %+v", p)
	}

	conn.Close()
	waitFor(t, "primaryShj gone", func() bool { return primaryShjOf(t, c, id) == nil })

	// 終わったあとは、次の shj が名乗れる。
	if r3, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/c.sock", PID: 33}); !r3.OK {
		t.Fatalf("after the end: %+v", r3)
	}
}

// 分割したターミナルの shj はプライマリの shj にならない。
func TestSplitTerminalShjIsNotPrimary(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id, _ := createWS(t, c)
	var res struct {
		TermID string `json:"termId"`
	}
	if err := c.Call(context.Background(), "term.create", map[string]any{"workspaceId": id, "cols": 80, "rows": 24}, &res); err != nil {
		t.Fatal(err)
	}
	if r, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: res.TermID, Socket: "/run/a.sock", PID: 1}); r.OK {
		t.Fatal("a split terminal is not a primary")
	}
	if r, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: "t999", Socket: "/run/a.sock", PID: 1}); r.OK {
		t.Fatal("unknown terminal")
	}
	if primaryShjOf(t, c, id) != nil {
		t.Fatal("primaryShj must stay null")
	}
}

// 環境変数 SHIJIMI_GUI_PRIMARY はプライマリにだけ渡る（restart でも）。
func TestPrimaryEnvOnlyInPrimary(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	var res struct {
		TermID string `json:"termId"`
	}
	if err := c.Call(context.Background(), "term.create", map[string]any{"workspaceId": id, "cols": 80, "rows": 24}, &res); err != nil {
		t.Fatal(err)
	}
	for term, want := range map[string]string{primary: "P=" + primary + ".", res.TermID: "P=."} {
		c.Call(context.Background(), "term.input", map[string]any{"termId": term, "data": b64("echo P=$" + ctl.EnvGUIPrimary + ".\n")}, nil)
		waitFor(t, "env of "+term, func() bool { d, _ := nt.output(t, term); return strings.Contains(string(d), want) })
	}
}
