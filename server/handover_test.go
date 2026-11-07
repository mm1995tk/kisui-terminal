package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/internal/term"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// handoverChildEnv があると、このテストの実行ファイルは `serve --handover` で起動されたとき、
// 引き継ぐ側の kisui serve として動く（値はソケットの場所）。handoverModeEnv で失敗のしかたを選ぶ。
const (
	handoverChildEnv = "KISUI_SERVER_TEST_HANDOVER"
	handoverModeEnv  = "KISUI_SERVER_TEST_HANDOVER_MODE"
)

func TestMain(m *testing.M) {
	if sock := os.Getenv(handoverChildEnv); sock != "" && len(os.Args) == 3 && os.Args[1] == "serve" && os.Args[2] == "--handover" {
		os.Exit(handoverChild(sock))
	}
	os.Exit(m.Run())
}

// handoverChild は cmd/kisui の runServe の --handover と同じことをする。
func handoverChild(sock string) int {
	f := os.NewFile(3, "handover")
	if os.Getenv(handoverModeEnv) == "refuse" {
		RefuseHandover(f, errors.New("refused for the test"))
		return 1
	}
	srv, err := Adopt(Options{
		SocketPath: sock, Shj: Shj{Version: "v2", Commit: "def", Channel: "stable"},
		CwdInterval: 20 * time.Millisecond, TreeInterval: 20 * time.Millisecond, GitInterval: 50 * time.Millisecond,
	}, f)
	if err != nil {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	if err := srv.Serve(ctx); err != nil {
		return 1
	}
	return 0
}

// handOver は c（古い serve につないだ GUI）から server.handover を頼み、新しい serve の pid を返す。
// 新しい serve はテストの終わりに SIGTERM で止める（シェルも終わる）。
func handOver(t *testing.T, c *rpc.Conn, sock string) int {
	t.Helper()
	t.Setenv(handoverChildEnv, sock)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var r struct {
		PID int `json:"pid"`
	}
	if err := c.Call(context.Background(), "server.handover", map[string]any{"executable": exe, "env": map[string]string{"KISUI_TEST_MARK": "from-gui"}}, &r); err != nil {
		t.Fatal(err)
	}
	if r.PID <= 0 || r.PID == os.Getpid() {
		t.Fatalf("pid of the new serve: %d", r.PID)
	}
	t.Cleanup(func() {
		p, err := os.FindProcess(r.PID)
		if err != nil {
			return
		}
		_ = p.Signal(syscall.SIGTERM)
		deadline := time.Now().Add(10 * time.Second)
		for p.Signal(syscall.Signal(0)) == nil && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
	})
	return r.PID
}

func listTerms(t *testing.T, c *rpc.Conn) map[string]map[string]any {
	t.Helper()
	var l struct {
		Terms []map[string]any `json:"terms"`
	}
	if err := c.Call(context.Background(), "term.list", map[string]any{}, &l); err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]any{}
	for _, x := range l.Terms {
		out[x["termId"].(string)] = x
	}
	return out
}

func attachTerm(t *testing.T, c *rpc.Conn, id string) attachResult {
	t.Helper()
	var a attachResult
	if err := c.Call(context.Background(), "term.attach", map[string]any{"termId": id}, &a); err != nil {
		t.Fatal(err)
	}
	return a
}

// 引き継いだあとも、欄のシェルとその中のプログラムが動き続け、入力と出力が新しい serve を通る。
// 引き継ぐ間に出た出力も落ちない。GUI は同じ serverId でつなぎ直せる。
func TestHandoverKeepsShellsRunning(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	t.Setenv(EnvShjDir, t.TempDir()) // 古い GUI が渡した、古い版の shj のフォルダ
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	wsID, primary := createWS(t, c)
	id := createTerm(t, c, map[string]any{"workspaceId": wsID, "split": map[string]any{"target": primary, "dir": "down"}})
	wantLayout := listWS(t, c).Workspaces[0].Layout
	if wantLayout.Dir != "down" {
		t.Fatalf("layout before handover: %+v", wantLayout)
	}
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("while read l; do echo \"got:$l\"; done\n")}, nil)
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("one\n")}, nil)
	waitFor(t, "got:one", func() bool { out, _ := nt.output(t, id); return bytes.Contains(out, []byte("got:one")) })
	// 引き継ぐ間に出る出力
	c.Call(ctx, "term.input", map[string]any{"termId": primary, "data": b64("sleep 0.2; echo LATE-OUTPUT\n")}, nil)
	before := listTerms(t, c)

	pid := handOver(t, c, sock)

	// 古い serve は GUI の接続を閉じる
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the old serve did not close the GUI connection")
	}
	c2, nt2 := termClient(t, sock)
	var info InfoResult
	if err := c2.Call(ctx, "server.info", struct{}{}, &info); err != nil {
		t.Fatal(err)
	}
	if info.PID != pid || info.ServerID != srv.ServerID() || info.Shj.Version != "v2" {
		t.Fatalf("server.info after handover: %+v", info)
	}
	if got := listWS(t, c2).Workspaces[0].Layout; !layoutEqual(got, wantLayout) {
		t.Errorf("layout after handover: %+v, want %+v", got, wantLayout)
	}
	after := listTerms(t, c2)
	for tid, x := range before {
		y := after[tid]
		if y == nil || y["pid"] != x["pid"] || y["workspaceId"] != x["workspaceId"] || y["primary"] != x["primary"] || y["alive"] != true {
			t.Errorf("terminal %s: before %v, after %v", tid, x, y)
		}
	}
	// 動いていたプログラムに、新しい serve を通して入力が届き、出力が返る
	if err := c2.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("two\n")}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "got:two", func() bool { out, _ := nt2.output(t, id); return bytes.Contains(out, []byte("got:two")) })
	// 引き継ぐ間に出た出力は、画面の状態に入っている
	waitFor(t, "LATE-OUTPUT", func() bool {
		return bytes.Contains(attachTerm(t, c2, primary).snapshot(t), []byte("LATE-OUTPUT"))
	})
	// 新しく作るターミナルの id は続きから
	nid := createTerm(t, c2, map[string]any{"workspaceId": wsID})
	if _, ok := before[nid]; ok || termIDNum(nid) <= termIDNum(id) {
		t.Errorf("new terminal id %s after %s", nid, id)
	}
	// 新しい serve の環境変数：古い版を指す KISUI_SHJ_DIR は外れ、頼んだ側の env が入る
	c2.Call(ctx, "term.input", map[string]any{"termId": nid, "data": b64("echo \"env:[$KISUI_TEST_MARK][$KISUI_SHJ_DIR]\"\n")}, nil)
	waitFor(t, "env of the new serve", func() bool {
		out, _ := nt2.output(t, nid)
		return bytes.Contains(out, []byte("env:[from-gui][]"))
	})
	// 新しい serve でも、もう一度引き継げる
	pid2 := handOver(t, c2, sock)
	c3, nt3 := termClient(t, sock)
	if err := c3.Call(ctx, "server.info", struct{}{}, &info); err != nil || info.PID != pid2 {
		t.Fatalf("second handover: %v %+v", err, info)
	}
	c3.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("three\n")}, nil)
	waitFor(t, "got:three", func() bool { out, _ := nt3.output(t, id); return bytes.Contains(out, []byte("got:three")) })
}

// 引き継いだあとの term.attach は、引き継ぐ前と同じ画面（画面・scrollback・モード）と seq を返す。
func TestHandoverKeepsScreen(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64(
		`i=0; while [ $i -lt 60 ]; do echo "scroll-$i"; i=$((i+1)); done; printf '\033[?1000h\033[?1006h\033[?2004h\033[?1h\033[>1u\033]0;the-title\007\033[31mRED\033[0m'; echo; echo MA""RK` + "\n")}, nil)
	waitFor(t, "output", func() bool { out, _ := nt.output(t, id); return bytes.Contains(out, []byte("MARK\r\n")) })
	// プロンプトまで出し切って、出力が止まってから取る
	var a attachResult
	for prev := int64(-1); ; time.Sleep(150 * time.Millisecond) {
		a = attachTerm(t, c, id)
		if a.Seq == prev {
			break
		}
		prev = a.Seq
	}

	handOver(t, c, sock)
	c2, _ := termClient(t, sock)
	b := attachTerm(t, c2, id)
	if a.Seq != b.Seq || a.Cols != b.Cols || a.Rows != b.Rows {
		t.Fatalf("attach before %d %dx%d, after %d %dx%d", a.Seq, a.Cols, a.Rows, b.Seq, b.Cols, b.Rows)
	}
	if !bytes.Equal(a.snapshot(t), b.snapshot(t)) {
		t.Fatalf("the screen changed across the handover:\nbefore %q\nafter  %q", a.snapshot(t), b.snapshot(t))
	}
	for _, want := range []string{"scroll-0", "RED", "\x1b[?1000h", "\x1b[?2004h"} {
		if !bytes.Contains(b.snapshot(t), []byte(want)) {
			t.Errorf("snapshot lacks %q", want)
		}
	}
	if x := listTerms(t, c2)[id]; x["title"] != "the-title" {
		t.Errorf("title after handover: %v", x["title"])
	}
}

// 引き継いだシェルが終わると、新しい serve が気づいて term.exit を送る（子ではないので code は無い）。
func TestHandoverNoticesShellExit(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	id := createTerm(t, c, nil)
	handOver(t, c, sock)
	c2, nt2 := termClient(t, sock)
	if err := c2.Call(context.Background(), "term.input", map[string]any{"termId": id, "data": b64("exit 3\n")}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "term.exit", func() bool {
		for _, m := range nt2.all("term.exit") {
			var p map[string]any
			json.Unmarshal(*m, &p)
			if p["termId"] == id {
				if _, ok := p["code"]; ok {
					t.Errorf("term.exit of an adopted shell has a code: %v", p)
				}
				return true
			}
		}
		return false
	})
	if x := listTerms(t, c2)[id]; x["alive"] != false {
		t.Errorf("alive after exit: %v", x)
	}
}

// プライマリの shj とのつながりは、引き継ぎで切れない。引き継ぐときに読みかけだった行も落ちない。
func TestHandoverKeepsPrimaryShj(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	_, sock := startFast(t)
	c, _ := termClient(t, sock)
	wsID, primary := createWS(t, c)
	r, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})
	if !r.OK {
		t.Fatalf("reply: %+v", r)
	}
	conn.Write([]byte(`{"file":"/x/a.txt"}` + "\n"))
	waitFor(t, "file a", func() bool { p := primaryShjOf(t, c, wsID); return p != nil && p.File == "/x/a.txt" })
	conn.Write([]byte(`{"file":"/x/b`)) // 行の途中で引き継ぐ
	time.Sleep(50 * time.Millisecond)

	handOver(t, c, sock)
	c2, _ := termClient(t, sock)
	if p := primaryShjOf(t, c2, wsID); p == nil || p.PID != 11 || p.File != "/x/a.txt" {
		t.Fatalf("primaryShj after handover: %+v", p)
	}
	conn.Write([]byte(`.txt"}` + "\n"))
	waitFor(t, "file b through the new serve", func() bool {
		p := primaryShjOf(t, c2, wsID)
		return p != nil && p.File == "/x/b.txt"
	})
	// 名乗れるのは 1 つだけのまま
	if r2, _ := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/b.sock", PID: 22}); r2.OK {
		t.Fatal("a second shj must be refused")
	}
	conn.Close()
	waitFor(t, "primaryShj gone", func() bool { return primaryShjOf(t, c2, wsID) == nil })
}

// 引き継ぎに失敗したら、古い serve はそのまま動き続ける（シェル・出力・shj のつながりを失わない）。
func TestHandoverFailureKeepsOldServe(t *testing.T) {
	t.Setenv("HOME", normalizePath(t.TempDir()))
	srv, sock := startFast(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	wsID, primary := createWS(t, c)
	id := createTerm(t, c, map[string]any{"workspaceId": wsID})
	_, conn := announceShj(t, sock, ctl.PrimaryHello{TermID: primary, Socket: "/run/a.sock", PID: 11})

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(t.TempDir(), "broken")
	if err := os.WriteFile(broken, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, exe, sock, mode, want string
		code                        int
	}{
		{"relative path", "kisui", sock, "", "absolute", rpc.CodeInvalidParams},
		{"exits at once", broken, sock, "", "did not answer", rpc.CodeInternalError},
		{"refuses", exe, sock, "refuse", "refused for the test", rpc.CodeInternalError},
		{"another socket", exe, sock + "-other", "", "socket differs", rpc.CodeInternalError},
	}
	for i, tc := range cases {
		t.Setenv(handoverChildEnv, tc.sock)
		t.Setenv(handoverModeEnv, tc.mode)
		err := c.Call(ctx, "server.handover", map[string]any{"executable": tc.exe}, nil)
		if e, ok := err.(*rpc.Error); !ok || e.Code != tc.code || !strings.Contains(e.Message, tc.want) {
			t.Fatalf("%s: %v", tc.name, err)
		}
		// 古い serve が、同じ接続で動き続ける
		var info InfoResult
		if err := c.Call(ctx, "server.info", struct{}{}, &info); err != nil || info.ServerID != srv.ServerID() || info.PID != os.Getpid() {
			t.Fatalf("%s: server.info: %v %+v", tc.name, err, info)
		}
		word := "alive-" + string(rune('a'+i))
		c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("echo " + word + "\n")}, nil)
		waitFor(t, tc.name+": output", func() bool { out, _ := nt.output(t, id); return bytes.Contains(out, []byte(word+"\r\n")) })
		file := "/x/" + word
		conn.Write([]byte(`{"file":"` + file + `"}` + "\n"))
		waitFor(t, tc.name+": shj", func() bool { p := primaryShjOf(t, c, wsID); return p != nil && p.File == file })
		// 新しい接続も受けられる
		c2 := dial(t, sock)
		if err := c2.Call(ctx, "session.ping", struct{}{}, nil); err != nil {
			t.Fatalf("%s: new connection: %v", tc.name, err)
		}
		c2.Close()
	}
	// 失敗したあとでも引き継げる
	t.Setenv(handoverModeEnv, "")
	handOver(t, c, sock)
	c3, nt3 := termClient(t, sock)
	c3.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("echo after-retry\n")}, nil)
	waitFor(t, "after retry", func() bool { out, _ := nt3.output(t, id); return bytes.Contains(out, []byte("after-retry\r\n")) })
}

// 引き継ぎの間に届いた要求は、何もせずに busy（reason: handover）で断る。古い serve を引き継いだあとに
// 名乗ろうとした shj の接続も断る。
func TestHandedOverServeRefuses(t *testing.T) {
	srv, sock := start(t)
	c := dial(t, sock)
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	srv.mu.Lock()
	srv.handedOver = true
	srv.mu.Unlock()
	err := c.Call(context.Background(), "server.info", struct{}{}, nil)
	e, ok := err.(*rpc.Error)
	if !ok || e.Code != rpc.CodeBusy || !strings.Contains(string(e.Data), "handover") {
		t.Fatalf("after handover: %v", err)
	}
	pc, err := net.Dial("unix", filepath.Join(filepath.Dir(sock), ctl.ServePrimaryName))
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	pc.Write([]byte(`{"termId":"t1","socket":"/run/a.sock","pid":1}` + "\n"))
	var r ctl.PrimaryReply
	if err := json.NewDecoder(pc).Decode(&r); err != nil || r.OK {
		t.Fatalf("hello after handover: %v %+v", err, r)
	}
}

func TestHelloAdvertisesHandover(t *testing.T) {
	_, sock := start(t)
	c := dial(t, sock)
	var h HelloResult
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), &h); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, x := range h.Capabilities {
		found = found || x == CapHandover
	}
	if !found {
		t.Errorf("capabilities: %v", h.Capabilities)
	}
}

// 新しい serve の環境変数は、古い serve のものから KISUI_SHJ_DIR を外し、頼んだ側の env を上書きしたもの。
func TestSuccessorEnv(t *testing.T) {
	base := []string{"HOME=/h", "PATH=/old/bin", EnvShjDir + "=/old/shj", "LANG=C"}
	got := successorEnv(base, map[string]string{"PATH": "/new/bin", "X": "1"})
	want := []string{"HOME=/h", "LANG=C", "PATH=/new/bin", "X=1"}
	if !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	got = successorEnv(base, map[string]string{EnvShjDir: "/new/shj"})
	if !slices.Contains(got, EnvShjDir+"=/new/shj") || slices.Contains(got, EnvShjDir+"=/old/shj") {
		t.Errorf("KISUI_SHJ_DIR: %v", got)
	}
}

// 引き継いだシェル（子でない）が終わったら、もう合図を送らない（pid が使い回されても別のプロセスに届かない）。
func TestAdoptedShellExitForgetsProcess(t *testing.T) {
	srv, _ := start(t)
	sess, err := term.Start(term.Options{Shell: "/bin/sh", Args: []string{"-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	go sess.Cmd().Wait() // 刈り取るのは前の serve（ここではテスト）
	p, err := os.FindProcess(sess.Pid())
	if err != nil {
		t.Fatal(err)
	}
	tm := &terminal{
		mgr: srv.terms, id: "t99", pid: sess.Pid(), ptmx: pollable(sess.File(), srv.log), process: p,
		alive: true, cols: 80, rows: 24, ring: make([]byte, ringSize), feed: newScreenFeed(srv.log, 24, 80),
	}
	srv.terms.mu.Lock()
	srv.terms.terms[tm.id] = tm
	tm.startPump()
	srv.terms.mu.Unlock()
	waitFor(t, "exit", func() bool {
		_, proc := tm.proc()
		return !tm.isAlive() && proc == nil
	})
}
