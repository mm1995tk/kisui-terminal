package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// paneCmdDo は欄の中のコマンドが serve に頼むところ（kisui open）。
func paneCmdDo(t *testing.T, sock string, rq panecmd.Request) panecmd.Reply {
	t.Helper()
	c, err := net.Dial("unix", filepath.Join(filepath.Dir(sock), ctl.ServePrimaryName))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	b, _ := json.Marshal(rq)
	c.Write(append(b, '\n'))
	var r panecmd.Reply
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&r); err != nil {
		t.Fatal(err)
	}
	return r
}

func termToken(t *testing.T, srv *Server, id string) string {
	t.Helper()
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatal(err)
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.token
}

// どのターミナルにも、ソケット・id・秘密が渡る。秘密はターミナルごとに違う。
func TestPaneCmdEnv(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	var res struct {
		TermID string `json:"termId"`
	}
	if err := c.Call(context.Background(), "term.create", map[string]any{"workspaceId": id, "cols": 80, "rows": 24}, &res); err != nil {
		t.Fatal(err)
	}
	if termToken(t, srv, primary) == termToken(t, srv, res.TermID) {
		t.Fatal("each terminal has its own secret")
	}
	socket := filepath.Join(filepath.Dir(sock), ctl.ServePrimaryName)
	for _, term := range []string{primary, res.TermID} {
		c.Call(context.Background(), "term.input", map[string]any{"termId": term, "data": b64("echo E=$" + panecmd.EnvSocket + ",$" + panecmd.EnvPane + ",$" + panecmd.EnvToken + ".\n")}, nil)
		want := "E=" + socket + "," + term + "," + termToken(t, srv, term) + "."
		waitFor(t, "env of "+term, func() bool { d, _ := nt.output(t, term); return strings.Contains(string(d), want) })
	}
}

// 欄の中から、shj がいなくても、ファイルの種類と URL に合う欄で開ける。id か秘密が合わなければ断る。
func TestPaneCmdOpen(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	png := write("a.png", "pngdata")
	pdf := write("a.pdf", "%PDF-1.4")
	mp4 := write("a.mp4", "mp4data")
	sniffed := write("noext", "%PDF-1.4\n")
	txt := write("a.txt", "hello")
	open := func(target string) panecmd.Reply {
		return paneCmdDo(t, sock, panecmd.Request{Cmd: "open", Pane: primary, Token: token, Target: target})
	}

	for _, bad := range []panecmd.Request{
		{Cmd: "open", Pane: primary, Token: "wrong", Target: png},
		{Cmd: "open", Pane: primary, Target: png},
		{Cmd: "open", Pane: "t99", Token: token, Target: png},
	} {
		if r := paneCmdDo(t, sock, bad); r.OK || r.Code != panecmd.CodeNotInPane {
			t.Fatalf("%+v must be refused as not in a pane: %+v", bad, r)
		}
	}
	for _, bad := range []string{txt, dir, "a.png", filepath.Join(dir, "none.png"), "ftp://example.com/", "javascript://x"} {
		if r := open(bad); r.OK || r.Code != "" {
			t.Fatalf("%q must be refused: %+v", bad, r)
		}
	}
	if r := paneCmdDo(t, sock, panecmd.Request{Cmd: "nope", Pane: primary, Token: token}); r.OK {
		t.Fatal("an unknown command must be refused")
	}

	want := map[string]string{png: "image", pdf: "pdf", mp4: "video", "https://example.com/a": "browser"}
	ids := map[string]string{}
	for target := range want {
		r := open(target)
		if !r.OK || r.ID == "" {
			t.Fatalf("open %q: %+v", target, r)
		}
		ids[target] = r.ID
		waitFor(t, "pane.show of "+target, func() bool {
			for _, m := range nt.all("pane.show") {
				if strings.Contains(string(*m), `"extraId":"`+r.ID+`"`) && strings.Contains(string(*m), `"workspaceId":"`+id+`"`) {
					return true
				}
			}
			return false
		})
	}
	list := func() []extraPane {
		var l struct {
			Workspaces []wsInfo `json:"workspaces"`
		}
		if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 {
			t.Fatalf("workspace.list: %v %+v", err, l)
		}
		for _, e := range l.Workspaces[0].Extras {
			if !layoutHas(l.Workspaces[0].Layout, e.ID) {
				t.Fatalf("pane %s is not in the layout: %+v", e.ID, l.Workspaces[0].Layout)
			}
		}
		return l.Workspaces[0].Extras
	}
	got := list()
	if len(got) != 4 {
		t.Fatalf("extras: %+v", got)
	}
	for _, e := range got {
		target := e.Path
		if e.Kind == "browser" {
			target = e.URL
		}
		if want[target] != e.Kind || ids[target] != e.ID {
			t.Fatalf("extra %+v", e)
		}
	}
	// 拡張子の無いファイルは中身で見分ける。同じ種類の欄は入れ替わる。
	r := open(sniffed)
	if !r.OK {
		t.Fatalf("open sniffed: %+v", r)
	}
	got = list()
	if len(got) != 4 || got[3].ID != r.ID || got[3].Kind != "pdf" || got[3].MIME != "application/pdf" {
		t.Fatalf("extras after the sniffed pdf: %+v", got)
	}

	// shj が開かせた同じ種類の欄とも入れ替わり、shj が終わっても欄の中から開いたものは残る。
	r0, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	if !r0.OK {
		t.Fatalf("hello: %+v", r0)
	}
	rs := paneDo(t, sock, ctl.PaneRequest{Op: "open", Kind: "image", Path: png, TermID: primary, PID: 11})
	if !rs.OK {
		t.Fatalf("shj open: %+v", rs)
	}
	if got = list(); len(got) != 4 || got[3].ID != rs.ID {
		t.Fatalf("extras after the shj's image: %+v", got)
	}
	// shj は、自分が開かせていない欄を閉じられない。
	if r := paneDo(t, sock, ctl.PaneRequest{Op: "close", ID: ids[mp4], TermID: primary, PID: 11}); r.OK {
		t.Fatal("the shj must not close a pane it did not open")
	}
	conn.Close()
	waitFor(t, "the shj's pane closes with it", func() bool { return len(list()) == 3 })

	// GUI の extra.close で閉じられる。
	if err := c.Call(context.Background(), "extra.close", map[string]any{"workspaceId": id, "id": ids[mp4]}, nil); err != nil {
		t.Fatal(err)
	}
	if got = list(); len(got) != 2 {
		t.Fatalf("extras after extra.close: %+v", got)
	}
}

func TestDetectFileKind(t *testing.T) {
	dir := t.TempDir()
	for name, want := range map[string]string{
		"a.JPG":  "image",
		"a.webm": "video",
		"a.pdf":  "pdf",
		"a.md":   "",
		"png":    "image", // 中身が PNG
	} {
		body := "x"
		if name == "png" {
			body = "\x89PNG\r\n\x1a\n0000"
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, _ := detectFileKind(p); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}

// 引き継いだあとも、同じ秘密で頼め、欄の中から開いた欄は残る。
func TestHandoverKeepsPaneCmd(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, _ := termClient(t, sock)
	wsID, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	png := filepath.Join(t.TempDir(), "a.png")
	if err := os.WriteFile(png, []byte("pngdata"), 0o644); err != nil {
		t.Fatal(err)
	}
	open := func(target string) panecmd.Reply {
		return paneCmdDo(t, sock, panecmd.Request{Cmd: "open", Pane: primary, Token: token, Target: target})
	}
	r := open(png)
	if !r.OK {
		t.Fatalf("open: %+v", r)
	}
	if r := paneCmdDo(t, sock, panecmd.Request{Cmd: "title", Pane: primary, Token: token, Title: "build"}); !r.OK {
		t.Fatalf("title: %+v", r)
	}

	handOver(t, c, sock)
	c2, _ := termClient(t, sock)
	var l struct {
		Workspaces []wsInfo `json:"workspaces"`
	}
	if err := c2.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 || l.Workspaces[0].ID != wsID ||
		len(l.Workspaces[0].Extras) != 1 || l.Workspaces[0].Extras[0].ID != r.ID || l.Workspaces[0].Titles[primary] != "build" {
		t.Fatalf("workspace.list after handover: %v %+v", err, l)
	}
	if r := open("https://example.com/"); !r.OK {
		t.Fatalf("open after handover: %+v", r)
	}
	if r := paneCmdDo(t, sock, panecmd.Request{Cmd: "open", Pane: primary, Token: "wrong", Target: png}); r.OK {
		t.Fatal("a wrong secret must be refused after handover")
	}
}

// kisui pane split は打った欄を分け、コマンドがあれば新しい欄で動かす。小さすぎる欄は断る。
// kisui pane title は欄に名前を付け、GUI（workspace.list）に出る。
func TestPaneCmdSplitAndTitle(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	do := func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = primary, token
		return paneCmdDo(t, sock, rq)
	}
	ws := func() wsInfo { return listWS(t, c).Workspaces[0] }

	for _, bad := range []panecmd.Request{
		{Cmd: "split"},
		{Cmd: "split", Dir: "left"},
		{Cmd: "split", Dir: "right", Argv: []string{"sh"}},
		{Cmd: "split", Dir: "right", Env: []string{"NOEQUALS"}},
		{Cmd: "title", Title: "a\nb"},
		{Cmd: "title", Title: strings.Repeat("あ", maxPaneName+1)},
	} {
		if r := do(bad); r.OK || r.Code != "" {
			t.Fatalf("%+v must be refused: %+v", bad, r)
		}
	}
	if r := paneCmdDo(t, sock, panecmd.Request{Cmd: "split", Dir: "right", Pane: primary, Token: "wrong"}); r.OK || r.Code != panecmd.CodeNotInPane {
		t.Fatalf("a wrong secret: %+v", r)
	}

	// 右に分ける（シェル）。新しい欄が右に入る
	r := do(panecmd.Request{Cmd: "split", Dir: "right"})
	if !r.OK || r.ID == "" {
		t.Fatalf("split right: %+v", r)
	}
	if l := ws().Layout; l.Dir != "right" || l.A.Pane != primary || l.B.Pane != r.ID {
		t.Fatalf("layout after split right: %+v", l)
	}
	waitFor(t, "pane.show of the new pane", func() bool {
		for _, m := range nt.all("pane.show") {
			if strings.Contains(string(*m), `"termId":"`+r.ID+`"`) {
				return true
			}
		}
		return false
	})

	// 下に分ける（コマンド）。打った欄の下に入り、コマンドの出力が出る
	r2 := do(panecmd.Request{Cmd: "split", Dir: "down", Argv: []string{"/bin/sh", "-c", "echo from-$X; sleep 30"}, Env: []string{"X=cmd"}, Cwd: t.TempDir()})
	if !r2.OK {
		t.Fatalf("split down: %+v", r2)
	}
	if l := ws().Layout; l.A.Dir != "down" || l.A.A.Pane != primary || l.A.B.Pane != r2.ID {
		t.Fatalf("layout after split down: %+v", l)
	}
	waitFor(t, "output of the command", func() bool { d, _ := nt.output(t, r2.ID); return strings.Contains(string(d), "from-cmd") })

	// 小さい欄は分けない
	small := createTerm(t, c, map[string]any{"workspaceId": id, "cols": 30, "rows": 8})
	smallToken := termToken(t, srv, small)
	if r := paneCmdDo(t, sock, panecmd.Request{Cmd: "split", Dir: "right", Pane: small, Token: smallToken}); r.OK || !strings.Contains(r.Error, "too narrow") {
		t.Fatalf("a small pane must not split: %+v", r)
	}

	// 名前
	if r := do(panecmd.Request{Cmd: "title", Title: "  build "}); !r.OK {
		t.Fatalf("title: %+v", r)
	}
	if got := ws().Titles; len(got) != 1 || got[primary] != "build" {
		t.Fatalf("titles: %+v", got)
	}
	if r := do(panecmd.Request{Cmd: "title", Title: ""}); !r.OK {
		t.Fatalf("clear the title: %+v", r)
	}
	if got := ws().Titles; len(got) != 0 {
		t.Fatalf("titles after clearing: %+v", got)
	}
}
