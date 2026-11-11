package server

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
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
	if r := paneDo(t, sock, rq("explorer")); !r.OK {
		t.Fatalf("explorer: %+v", r)
	}
	waitFor(t, "explorer.focus", func() bool {
		ms := nt.all("explorer.focus")
		return len(ms) == 1 && strings.Contains(string(*ms[0]), `"workspaceId":"`+id+`"`)
	})
	if r := paneDo(t, sock, rq("changes")); !r.OK {
		t.Fatalf("changes: %+v", r)
	}
	waitFor(t, "changes.focus", func() bool {
		ms := nt.all("changes.focus")
		return len(ms) == 1 && strings.Contains(string(*ms[0]), `"workspaceId":"`+id+`"`)
	})
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

// 動画の欄を開き、範囲を指して読み、閉じる。動画の欄は 1 つで、新しいものと入れ替わる。shj が終わると消える。
func TestPrimaryShjVideoPane(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	r0, hello := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	if !r0.OK {
		t.Fatalf("hello: %+v", r0)
	}
	dir := t.TempDir()
	mp4 := filepath.Join(dir, "a.mp4")
	data := []byte("0123456789abcdef")
	if err := os.WriteFile(mp4, data, 0o644); err != nil {
		t.Fatal(err)
	}
	txt := filepath.Join(dir, "a.txt")
	_ = os.WriteFile(txt, data, 0o644)
	open := func(path string) ctl.PaneReply {
		return paneDo(t, sock, ctl.PaneRequest{Op: "open", Kind: "video", Path: path, TermID: primary, PID: 11})
	}
	extras := func() []extraPane {
		var l struct {
			Workspaces []wsInfo `json:"workspaces"`
		}
		if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 {
			t.Fatalf("workspace.list: %v %+v", err, l)
		}
		return l.Workspaces[0].Extras
	}

	for _, bad := range []string{txt, "a.mp4", filepath.Join(dir, "none.mp4"), dir} {
		if r := open(bad); r.OK {
			t.Fatalf("%q must be refused", bad)
		}
	}
	r := open(mp4)
	if !r.OK || r.ID == "" {
		t.Fatalf("open: %+v", r)
	}
	waitFor(t, "pane.show of the video", func() bool {
		for _, m := range nt.all("pane.show") {
			if strings.Contains(string(*m), `"extraId":"`+r.ID+`"`) {
				return true
			}
		}
		return false
	})
	if e := extras(); len(e) != 1 || e[0].ID != r.ID || e[0].Path != mp4 || e[0].MIME != "video/mp4" || e[0].Size != int64(len(data)) {
		t.Fatalf("extras: %+v", e)
	}

	var m MediaResult
	if err := c.Call(context.Background(), "media.read", map[string]any{"workspaceId": id, "id": r.ID, "offset": 4, "length": 6}, &m); err != nil {
		t.Fatal(err)
	}
	if got, _ := base64.StdEncoding.DecodeString(m.Data); string(got) != "456789" || m.EOF || m.Size != 16 || m.Mime != "video/mp4" {
		t.Fatalf("media.read: %+v %q", m, got)
	}
	if err := c.Call(context.Background(), "media.read", map[string]any{"workspaceId": id, "id": r.ID, "offset": 10}, &m); err != nil || !m.EOF {
		t.Fatalf("media.read to the end: %v %+v", err, m)
	}
	if err := c.Call(context.Background(), "media.read", map[string]any{"workspaceId": id, "id": "x99"}, &m); err == nil {
		t.Fatal("a pane that is not open cannot be read")
	}

	// 開き直すと入れ替わる。
	r2 := open(mp4)
	if !r2.OK || r2.ID == r.ID {
		t.Fatalf("open again: %+v", r2)
	}
	if e := extras(); len(e) != 1 || e[0].ID != r2.ID {
		t.Fatalf("extras after replacing: %+v", e)
	}

	// GUI が閉じる。
	if err := c.Call(context.Background(), "extra.close", map[string]any{"workspaceId": id, "id": r2.ID}, &struct{}{}); err != nil {
		t.Fatal(err)
	}
	if e := extras(); len(e) != 0 {
		t.Fatalf("extras after close: %+v", e)
	}

	// shj が閉じる。ほかの shj の欄は閉じられない。
	r3 := open(mp4)
	cl := ctl.PaneRequest{Op: "close", TermID: primary, PID: 11, ID: r3.ID}
	if r := paneDo(t, sock, cl); !r.OK {
		t.Fatalf("close: %+v", r)
	}
	if e := extras(); len(e) != 0 {
		t.Fatalf("extras after close by the shj: %+v", e)
	}

	// shj が終わると、動画の欄は消える。
	if r := open(mp4); !r.OK {
		t.Fatalf("open: %+v", r)
	}
	hello.Close()
	waitFor(t, "the video pane closes with its shj", func() bool { return len(extras()) == 0 })
	_ = srv
}

func TestPrimaryShjBrowserOpensExternally(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	if r0, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11}); !r0.OK {
		t.Fatalf("hello: %+v", r0)
	}
	open := func(url string) ctl.PaneReply {
		return paneDo(t, sock, ctl.PaneRequest{Op: "open", Kind: "browser", URL: url, TermID: primary, PID: 11})
	}
	for _, bad := range []string{"", "localhost:3000", "file:///etc/passwd", "javascript:alert(1)", "ftp://x.example/", "https://", "https://u:p@example.com/", "http://a.example/\n", "tauri://localhost/"} {
		if r := open(bad); r.OK {
			t.Fatalf("%q must be refused", bad)
		}
	}
	// 欄は作らず（ID は空）、GUI に browser.open を通知する。
	r := open("http://localhost:3000/a?b=1")
	if !r.OK || r.ID != "" {
		t.Fatalf("open: %+v", r)
	}
	waitFor(t, "browser.open", func() bool {
		for _, m := range nt.all("browser.open") {
			if strings.Contains(string(*m), `"url":"http://localhost:3000/a?b=1"`) && strings.Contains(string(*m), `"workspaceId":"`+id+`"`) {
				return true
			}
		}
		return false
	})
	var l struct {
		Workspaces []wsInfo `json:"workspaces"`
	}
	if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 {
		t.Fatalf("workspace.list: %v %+v", err, l)
	}
	if e := l.Workspaces[0].Extras; len(e) != 0 {
		t.Fatalf("a URL makes no pane: %+v", e)
	}
	// 何度でも開ける（欄が無いので入れ替わらない）。
	if r := open("https://example.com/"); !r.OK {
		t.Fatalf("open again: %+v", r)
	}
	waitFor(t, "second browser.open", func() bool { return len(nt.all("browser.open")) == 2 })
	// 欄を作る extra.open は無い。
	if err := c.Call(context.Background(), "extra.open", map[string]any{"workspaceId": id, "url": "https://example.org/x"}, nil); err == nil {
		t.Fatal("extra.open must not exist")
	}
	// GUI（持ち主）がつながっていなければ、shj に分かる形で断る。
	c.Close()
	waitFor(t, "refusal without a GUI", func() bool {
		r := open("https://example.com/")
		return !r.OK && r.Error == "no GUI is connected to open the URL"
	})
}

// 画像と PDF の欄は動画と同じ道（fileKinds）で開き、media.read で取れる。種類ごとに欄は 1 つで、拡張子の違うファイルは断る。
func TestPrimaryShjImageAndPdfPane(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id, primary := createWS(t, c)
	if r0, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11}); !r0.OK {
		t.Fatalf("hello: %+v", r0)
	}
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	png, pdf, txt := write("a.PNG", "pngdata"), write("a.pdf", "%PDF-1.4"), write("a.txt", "x")
	open := func(kind, path string) ctl.PaneReply {
		return paneDo(t, sock, ctl.PaneRequest{Op: "open", Kind: kind, Path: path, TermID: primary, PID: 11})
	}
	for _, bad := range []struct{ kind, path string }{{"image", pdf}, {"pdf", png}, {"image", txt}, {"image", "a.png"}, {"pdf", dir}} {
		if r := open(bad.kind, bad.path); r.OK {
			t.Fatalf("%+v must be refused", bad)
		}
	}
	ri, rp := open("image", png), open("pdf", pdf)
	if !ri.OK || !rp.OK || ri.ID == rp.ID {
		t.Fatalf("open: %+v %+v", ri, rp)
	}
	for _, c2 := range []struct {
		id, mime, body string
	}{{ri.ID, "image/png", "pngdata"}, {rp.ID, "application/pdf", "%PDF-1.4"}} {
		var m MediaResult
		if err := c.Call(context.Background(), "media.read", map[string]any{"workspaceId": id, "id": c2.id}, &m); err != nil {
			t.Fatal(err)
		}
		if got, _ := base64.StdEncoding.DecodeString(m.Data); string(got) != c2.body || m.Mime != c2.mime || !m.EOF {
			t.Fatalf("media.read: %+v %q", m, got)
		}
	}
	// 同じ種類は入れ替わり、違う種類は並ぶ。
	if r := open("image", png); !r.OK || r.ID == ri.ID {
		t.Fatalf("open again: %+v", r)
	}
	var l struct {
		Workspaces []wsInfo `json:"workspaces"`
	}
	if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 || len(l.Workspaces[0].Extras) != 2 {
		t.Fatalf("workspace.list: %v %+v", err, l)
	}
}

func TestFileKindLimits(t *testing.T) {
	big := filepath.Join(t.TempDir(), "big.png")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(fileKinds["image"].maxSize + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := newExtra(ctl.PaneRequest{Op: "open", Kind: "image", Path: big}); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("a too large image must be refused: %v", err)
	}
}
