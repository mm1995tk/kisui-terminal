package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
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

// 環境変数 SHIJIMI_GUI_PRIMARY は分割した欄にも、その欄の id を値にして渡る。
func TestPrimaryEnvInEveryPane(t *testing.T) {
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
	for term, want := range map[string]string{primary: "P=" + primary + ".", res.TermID: "P=" + res.TermID + "."} {
		c.Call(context.Background(), "term.input", map[string]any{"termId": term, "data": b64("echo P=$" + ctl.EnvGUIPrimary + ".\n")}, nil)
		waitFor(t, "env of "+term, func() bool { d, _ := nt.output(t, term); return strings.Contains(string(d), want) })
	}
}

// 名乗った shj へのリンクが置かれ、終わると消える。ターミナルには SHIJIMI_GUI_WORKSPACE が渡る（分割にも）。
func TestPrimaryShjLinkAndWorkspaceEnv(t *testing.T) {
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
	for _, term := range []string{primary, res.TermID} {
		c.Call(context.Background(), "term.input", map[string]any{"termId": term, "data": b64("echo W=$" + ctl.EnvGUIWorkspace + ".\n")}, nil)
		want := "W=" + id + "."
		waitFor(t, "env of "+term, func() bool { d, _ := nt.output(t, term); return strings.Contains(string(d), want) })
	}

	link := ctl.GUILinkPath(filepath.Dir(sock), id)
	if _, err := os.Lstat(link); err == nil {
		t.Fatal("no link before a shj")
	}
	want := filepath.Join(filepath.Dir(sock), "11.sock")
	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: want, PID: 11})
	if !r.OK {
		t.Fatalf("reply: %+v", r)
	}
	if to, err := os.Readlink(link); err != nil || to != want {
		t.Fatalf("link: %q %v", to, err)
	}
	conn.Close()
	waitFor(t, "link removed", func() bool { _, err := os.Lstat(link); return err != nil })
}

// ソケットのディレクトリの外のソケットには、リンクを置かない（名乗りは通る）。
func TestPrimaryShjLinkOnlyInsideSocketDir(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id, primary := createWS(t, c)
	r, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/tmp/x.sock", PID: 11})
	if !r.OK {
		t.Fatalf("reply: %+v", r)
	}
	if _, err := os.Lstat(ctl.GUILinkPath(filepath.Dir(sock), id)); err == nil {
		t.Fatal("no link for a socket outside the socket directory")
	}
}

// shj が出しているファイルは primaryShj.file で届き、shj.open はプライマリの shj の制御用ソケットに open を頼む。
func TestPrimaryShjFileAndOpen(t *testing.T) {
	needCwd(t)
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id, primary := createWS(t, c)
	repo, _ := project(t)
	cd(t, c, primary, repo)
	waitFor(t, "folder", func() bool { return folderOfWS(t, c, id) == repo })
	if err := os.WriteFile(filepath.Join(repo, "a.go"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// shj の制御用ソケットのふり
	dir, err := os.MkdirTemp("", "shjo")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	shjSock := filepath.Join(dir, "1.sock")
	ln, err := net.Listen("unix", shjSock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	asked := make(chan ctl.Request, 1)
	go func() {
		for {
			cn, err := ln.Accept()
			if err != nil {
				return
			}
			var r ctl.Request
			json.NewDecoder(cn).Decode(&r)
			asked <- r
			json.NewEncoder(cn).Encode(ctl.Response{OK: true})
			cn.Close()
		}
	}()

	open := func(path string) error {
		return c.Call(context.Background(), "shj.open", map[string]any{"workspaceId": id, "path": path}, nil)
	}
	if err := open("a.go"); err == nil {
		t.Fatal("without a shj in the primary there is nobody to ask")
	}
	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: shjSock, PID: 11})
	if !r.OK {
		t.Fatalf("reply: %+v", r)
	}
	file := filepath.Join(repo, "a.go")
	b, _ := json.Marshal(ctl.PrimaryFile{File: file})
	conn.Write(append(b, '\n'))
	waitFor(t, "file", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == file })
	b, _ = json.Marshal(ctl.PrimaryFile{File: ""})
	conn.Write(append(b, '\n'))
	waitFor(t, "file cleared", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == "" })

	if err := open("a.go"); err != nil {
		t.Fatal(err)
	}
	if got := <-asked; got.Cmd != "open" || got.Path != file {
		t.Errorf("asked: %+v", got)
	}
	for _, bad := range []string{"../x", "/etc/passwd", "none.go", "pkg", ""} {
		if err := open(bad); err == nil {
			t.Errorf("open(%q) must be refused", bad)
		}
	}
	select {
	case got := <-asked:
		t.Errorf("a refused path reached the shj: %+v", got)
	default:
	}
}

// 版のない名乗り（今までの shj）は版 0 として受け、範囲の外の版は理由を付けて断る。
func TestPrimaryProtocolRange(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	_, primary := createWS(t, c)

	r, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11, Protocol: MaxPrimaryProtocol + 1})
	if r.OK || r.Code != ctl.ReplyCodeVersion || r.Min != MinPrimaryProtocol || r.Max != MaxPrimaryProtocol {
		t.Fatalf("a newer version must be refused with the range: %+v", r)
	}
	// 断られたあとも、版のない shj は名乗れる（断った名乗りは席を取らない）。
	if r, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/b.sock", PID: 22}); !r.OK {
		t.Fatalf("version 0 (no protocol) must be accepted: %+v", r)
	}
}

// 差分モードの一覧は primaryShj.diff に出て、終わると消える。shj.diff は一覧にあるファイルだけを shj に頼む。
func TestPrimaryShjDiffList(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id, primary := createWS(t, c)

	dir, err := os.MkdirTemp("", "shjd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	shjSock := filepath.Join(dir, "1.sock")
	ln, err := net.Listen("unix", shjSock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	asked := make(chan ctl.Request, 4)
	go func() {
		for {
			cn, err := ln.Accept()
			if err != nil {
				return
			}
			var r ctl.Request
			json.NewDecoder(cn).Decode(&r)
			asked <- r
			json.NewEncoder(cn).Encode(ctl.Response{OK: true})
			cn.Close()
		}
	}()

	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: shjSock, PID: 11})
	if !r.OK || !r.Changes || !r.ChangesPR {
		t.Fatalf("reply: %+v", r)
	}
	diff := func(path string) error {
		return c.Call(context.Background(), "shj.diff", map[string]any{"workspaceId": id, "path": path}, nil)
	}
	if err := diff("/x/a.go"); err == nil {
		t.Fatal("not in diff mode: nothing to select")
	}

	send := func(line string) { conn.Write([]byte(line + "\n")) }
	send(`{"file":"/x/a.go","diff":{"files":[{"path":"/x/a.go","status":"modified","added":2,"deleted":1},{"path":"/x/gone.go","status":"deleted","deleted":4},{"path":"rel.go"}],"selected":"/x/a.go"}}`)
	waitFor(t, "diff on", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.Diff != nil })
	p := primaryShjOf(t, c, id)
	if len(p.Diff.Files) != 2 || p.Diff.Selected != "/x/a.go" || p.Diff.Files[0].Added != 2 || p.Diff.Files[1].Status != "deleted" {
		t.Fatalf("diff: %+v", p.Diff)
	}

	if err := diff("/x/gone.go"); err != nil { // 削除されたファイルも頼める
		t.Fatal(err)
	}
	if got := <-asked; got.Cmd != "diff" || got.Path != "/x/gone.go" {
		t.Errorf("asked: %+v", got)
	}
	for _, bad := range []string{"/x/other.go", "/etc/passwd", "rel.go", "a.go", ""} {
		if err := diff(bad); err == nil {
			t.Errorf("diff(%q) must be refused", bad)
		}
	}
	select {
	case got := <-asked:
		t.Errorf("a refused path reached the shj: %+v", got)
	default:
	}

	// s・r・R だけを、差分モードのあいだ shj に頼む
	changesKey := func(k string) error {
		return c.Call(context.Background(), "shj.changesKey", map[string]any{"workspaceId": id, "key": k}, nil)
	}
	for _, k := range []string{"s", "r", "R", "space", ":"} {
		if err := changesKey(k); err != nil {
			t.Fatalf("changesKey(%q): %v", k, err)
		}
		if got := <-asked; got.Cmd != "changes-key" || got.Line != k {
			t.Errorf("asked: %+v", got)
		}
	}
	for _, bad := range []string{"j", "x", "", "sr", "space w", "space ", "Space"} {
		if err := changesKey(bad); err == nil {
			t.Errorf("changesKey(%q) must be refused", bad)
		}
	}

	send(`{"file":"/x/a.go","diff":{"files":[]}}`) // 変更が無くなっても、差分モードのあいだは一覧（空）を出す
	waitFor(t, "empty list", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.Diff != nil && len(p.Diff.Files) == 0 })
	// PR との差分モード（base "pr"）の一覧も出る。知らない base は HEAD。切り替わりは更新として届く
	send(`{"file":"/x/a.go","diff":{"files":[{"path":"/x/a.go"}],"base":"pr"}}`)
	waitFor(t, "pr list", func() bool {
		p := primaryShjOf(t, c, id)
		return p != nil && p.Diff != nil && p.Diff.Base == ctl.BasePR
	})
	if err := diff("/x/a.go"); err != nil {
		t.Fatal(err)
	}
	if got := <-asked; got.Cmd != "diff" || got.Path != "/x/a.go" {
		t.Errorf("asked: %+v", got)
	}
	for _, k := range []string{"r", "R", "space"} {
		if err := changesKey(k); err != nil {
			t.Fatalf("changesKey(%q) in the PR mode: %v", k, err)
		}
		if got := <-asked; got.Cmd != "changes-key" || got.Line != k {
			t.Errorf("asked: %+v", got)
		}
	}
	// viewed の欄は PR モードのときだけ通る。変わったら一覧が更新として届く。HEAD（知らない base も）では捨てる
	viewedOf := func() []bool {
		p := primaryShjOf(t, c, id)
		if p == nil || p.Diff == nil {
			return nil
		}
		var v []bool
		for _, f := range p.Diff.Files {
			v = append(v, f.Viewed)
		}
		return v
	}
	send(`{"file":"/x/a.go","diff":{"files":[{"path":"/x/a.go","viewed":true},{"path":"/x/b.go"}],"base":"pr"}}`)
	waitFor(t, "viewed in the PR mode", func() bool { return slices.Equal(viewedOf(), []bool{true, false}) })
	send(`{"file":"/x/a.go","diff":{"files":[{"path":"/x/a.go","viewed":true},{"path":"/x/b.go","viewed":true}],"base":"pr"}}`)
	waitFor(t, "viewed changed", func() bool { return slices.Equal(viewedOf(), []bool{true, true}) })
	send(`{"file":"/x/a.go","diff":{"files":[{"path":"/x/a.go","viewed":true}]}}`)
	waitFor(t, "viewed dropped in the HEAD mode", func() bool { return slices.Equal(viewedOf(), []bool{false}) })
	send(`{"file":"/x/a.go","diff":{"files":[{"path":"/x/a.go"}],"base":"other"}}`)
	waitFor(t, "unknown base is head", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.Diff != nil && p.Diff.Base == "" })
	send(`{"file":"/x/a.go"}`)
	waitFor(t, "diff off", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.Diff == nil })
	if err := changesKey("s"); err == nil {
		t.Error("changesKey outside the diff mode must be refused")
	}
}

// 上限を超える行は、その行だけ捨てる。接続は切らないので、shj は忘れられず、次の行は読まれる。
func TestPrimaryShjLongLineIsDropped(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id, primary := createWS(t, c)
	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	if !r.OK {
		t.Fatalf("reply: %+v", r)
	}
	conn.Write([]byte(`{"file":"/x/a.txt"}` + "\n"))
	waitFor(t, "file a", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == "/x/a.txt" })
	long := append([]byte(`{"file":"/x/long.txt","pad":"`), bytes.Repeat([]byte("a"), maxPrimaryLine+(1<<16))...)
	long = append(long, []byte("\"}\n")...)
	conn.Write(long)
	conn.Write([]byte(`{"file":"/x/b.txt"}` + "\n"))
	waitFor(t, "file b after the long line", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == "/x/b.txt" })
}

// 分割した欄は、昇格の前は名乗りを断られ、プライマリのシェルが終わって昇格したあとは名乗れる（#50）。
func TestPrimaryPromotedSplitCanAnnounce(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	split := createTerm(t, c, map[string]any{"workspaceId": id})

	// 昇格の前：環境変数は渡っているが、プライマリではないので断る
	c.Call(ctx, "term.input", map[string]any{"termId": split, "data": b64("echo P=$" + ctl.EnvGUIPrimary + ".\n")}, nil)
	waitFor(t, "env of split", func() bool { d, _ := nt.output(t, split); return strings.Contains(string(d), "P="+split+".") })
	if r, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: split, Socket: "/run/a.sock", PID: 1}); r.OK {
		t.Fatal("a split terminal is not a primary before the promotion")
	}

	c.Call(ctx, "term.input", map[string]any{"termId": primary, "data": b64("exit\n")}, nil)
	waitFor(t, "split becomes primary", func() bool {
		var l wsList
		if err := c.Call(ctx, "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 {
			return false
		}
		return l.Workspaces[0].Primary == split
	})
	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: split, Socket: "/run/b.sock", PID: 2})
	if !r.OK {
		t.Fatalf("a promoted terminal must be able to announce: %+v", r)
	}
	defer conn.Close()
	if primaryShjOf(t, c, id) == nil {
		t.Fatal("primaryShj must be set")
	}
}

// 引数なしで起動した shj（最初の PrimaryFile がファイルなし）は、ファイルツリーにキーを向けさせる。
// 最初の 1 回だけで、ファイルを開いて起動した shj は向けさせない。
func TestPrimaryShjStartFocusesExplorerOnlyWithoutFile(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	id, primary := createWS(t, c)
	send := func(conn net.Conn, f ctl.PrimaryFile) {
		b, _ := json.Marshal(f)
		conn.Write(append(b, '\n'))
	}

	// ファイルを開いて起動した: 向けさせない。あとで閉じても（ファイルなしになっても）向けさせない。
	file := filepath.Join(t.TempDir(), "a.go")
	_, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	send(conn, ctl.PrimaryFile{File: file})
	waitFor(t, "file", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == file })
	send(conn, ctl.PrimaryFile{})
	waitFor(t, "file cleared", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == "" })
	if n := len(nt.all("explorer.focus")); n != 0 {
		t.Fatalf("a shj started with a file must not move the focus: %d", n)
	}
	conn.Close()
	waitFor(t, "shj gone", func() bool { return primaryShjOf(t, c, id) == nil })

	// 引数なしで起動した: 1 回だけ向けさせる。
	_, conn = announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/b.sock", PID: 12})
	send(conn, ctl.PrimaryFile{})
	waitFor(t, "explorer.focus", func() bool {
		ms := nt.all("explorer.focus")
		return len(ms) == 1 && strings.Contains(string(*ms[0]), `"workspaceId":"`+id+`"`)
	})
	send(conn, ctl.PrimaryFile{File: file})
	send(conn, ctl.PrimaryFile{})
	waitFor(t, "file cleared", func() bool { p := primaryShjOf(t, c, id); return p != nil && p.File == "" })
	if n := len(nt.all("explorer.focus")); n != 1 {
		t.Fatalf("only the start moves the focus: %d", n)
	}
}
