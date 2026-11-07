package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"maps"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/rpc"
)

// notes は届いた通知を溜める。
type notes struct {
	mu  sync.Mutex
	got []*rpc.Message
}

func (n *notes) handle(_ context.Context, m *rpc.Message) (any, error) {
	if m.IsNotification() {
		n.mu.Lock()
		n.got = append(n.got, m)
		n.mu.Unlock()
	}
	return nil, nil
}

// output は term.output の中身を順に並べる。seq が連続していることも確かめる。
func (n *notes) output(t *testing.T, id string) (data []byte, last int64) {
	t.Helper()
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, m := range n.got {
		if m.Method != "term.output" {
			continue
		}
		var p struct {
			TermID string `json:"termId"`
			Seq    int64  `json:"seq"`
			Data   string `json:"data"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			t.Fatal(err)
		}
		if p.TermID != id {
			continue
		}
		b, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, b...)
		last = p.Seq
	}
	return
}

func (n *notes) find(method string) *rpc.Message {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, m := range n.got {
		if m.Method == method {
			return m
		}
	}
	return nil
}

func termClient(t *testing.T, sock string) (*rpc.Conn, *notes) {
	t.Helper()
	nt := &notes{}
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	cn := rpc.NewConn(c, rpc.JSON{}, nt.handle)
	t.Cleanup(func() { cn.Close() })
	if err := cn.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	return cn, nt
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// createWS は workspace.create を送り、ワークスペースとそのプライマリターミナルの id を返す。
func createWS(t *testing.T, c *rpc.Conn) (id, primary string) {
	t.Helper()
	var r struct {
		ID     string `json:"id"`
		TermID string `json:"termId"`
	}
	if err := c.Call(context.Background(), "workspace.create", map[string]any{}, &r); err != nil {
		t.Fatal(err)
	}
	if r.ID == "" || r.TermID == "" {
		t.Fatalf("workspace.create: %+v", r)
	}
	return r.ID, r.TermID
}

// createTerm は分割したターミナルを足して id を返す。extra に workspaceId が無ければ、ワークスペースも作る。
func createTerm(t *testing.T, c *rpc.Conn, extra map[string]any) string {
	t.Helper()
	p := map[string]any{"cols": 80, "rows": 24, "shell": "/bin/sh"}
	maps.Copy(p, extra)
	if _, ok := p["workspaceId"]; !ok {
		p["workspaceId"], _ = createWS(t, c)
	}
	var r struct {
		TermID string `json:"termId"`
		PID    int    `json:"pid"`
		Cwd    string `json:"cwd"`
	}
	if err := c.Call(context.Background(), "term.create", p, &r); err != nil {
		t.Fatal(err)
	}
	if r.TermID == "" || r.PID == 0 {
		t.Fatalf("create: %+v", r)
	}
	return r.TermID
}

func TestTermInputOutputExitTitle(t *testing.T) {
	srv, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)

	if err := c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("printf 'hi-%s\\033]0;mytitle\\007' there; exit 3\n")}, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "exit", func() bool { return nt.find("term.exit") != nil })
	out, _ := nt.output(t, id)
	if !bytes.Contains(out, []byte("hi-there")) {
		t.Errorf("output: %q", out)
	}
	var ex struct{ Code int }
	json.Unmarshal(nt.find("term.exit").Params, &ex)
	if ex.Code != 3 {
		t.Errorf("exit code %d", ex.Code)
	}
	var ti struct{ Title string }
	if m := nt.find("term.title"); m == nil {
		t.Error("no term.title")
	} else if json.Unmarshal(m.Params, &ti); ti.Title != "mytitle" {
		t.Errorf("title %q", ti.Title)
	}
	var l struct {
		Terms []struct {
			TermID string
			Title  string
			Alive  bool
			Cols   int
		}
	}
	if err := c.Call(ctx, "term.list", struct{}{}, &l); err != nil {
		t.Fatal(err)
	}
	if len(l.Terms) != 2 || l.Terms[1].TermID != id || l.Terms[1].Alive || l.Terms[1].Title != "mytitle" || l.Terms[1].Cols != 80 {
		t.Errorf("list: %+v", l)
	}
	if srv.terms.count() != 2 { // プライマリターミナルと分割したターミナル
		t.Errorf("count")
	}
	if err := c.Call(ctx, "term.close", map[string]any{"termId": id}, nil); err != nil {
		t.Fatal(err)
	}
	err := c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("x")}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeNotFound {
		t.Errorf("input after close: %v", err)
	}
}

func TestTermErrors(t *testing.T) {
	_, sock := start(t)
	c := dial(t, sock)
	ctx := context.Background()
	err := c.Call(ctx, "term.list", struct{}{}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeInvalidRequest {
		t.Errorf("before hello: %v", err)
	}
	c, _ = termClient(t, sock)
	err = c.Call(ctx, "term.create", map[string]any{"workspaceId": "w1", "cols": 0, "rows": 1}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeInvalidParams {
		t.Errorf("bad size: %v", err)
	}
	err = c.Call(ctx, "term.create", map[string]any{"workspaceId": "nope", "cols": 1, "rows": 1}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeNotFound {
		t.Errorf("unknown workspace: %v", err)
	}
	err = c.Call(ctx, "term.attach", map[string]any{"termId": "t99"}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeNotFound {
		t.Errorf("attach: %v", err)
	}
}

func TestTermResize(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	id := createTerm(t, c, nil)
	ctx := context.Background()
	if err := c.Call(ctx, "term.resize", map[string]any{"termId": id, "cols": 100, "rows": 30}, nil); err != nil {
		t.Fatal(err)
	}
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("stty size; exit\n")}, nil)
	waitFor(t, "exit", func() bool { return nt.find("term.exit") != nil })
	out, _ := nt.output(t, id)
	if !strings.Contains(string(out), "30 100") {
		t.Errorf("stty: %q", out)
	}
}

// ack が無いと 256 KiB で送るのが止まり、その間も溜まる。attach は、溜まった出力ではなく画面の状態の書き出しを返す。
func TestTermFlowControlAndAttach(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)

	// 600 KiB 出して止まる（リングには収まる量）。
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("head -c 614400 /dev/zero | tr '\\0' 'a'; printf END\n")}, nil)

	waitFor(t, "first window", func() bool { _, last := nt.output(t, id); return last >= ackWindow })
	time.Sleep(300 * time.Millisecond)
	_, last := nt.output(t, id)
	if last != ackWindow {
		t.Fatalf("sent %d before ack, want %d", last, ackWindow)
	}

	// attach は、溜めた出力の長さによらず、画面の状態（見えている画面 + scrollback）の書き出しを返す。
	var a attachResult
	waitFor(t, "buffer full", func() bool {
		if err := c.Call(ctx, "term.attach", map[string]any{"termId": id}, &a); err != nil {
			t.Fatal(err)
		}
		return a.Seq >= 614400
	})
	snap := a.snapshot(t)
	if !bytes.HasPrefix(snap, []byte("\x1bc")) || !bytes.Contains(snap, []byte("END")) {
		t.Errorf("snapshot does not start from a reset or lost the last line: %d bytes", len(snap))
	}
	if len(snap) >= 614400 { // scrollback 5000 行 × 80 桁までに収まる
		t.Errorf("snapshot is %d bytes; it should be the screen and 5000 lines of scrollback, not the output", len(snap))
	}
	if a.Cols != 80 || a.Rows != 24 {
		t.Errorf("size = %dx%d", a.Cols, a.Rows)
	}

	// attach したあとは、そこから先が流れる。ack すると続きが来る。
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("printf AFTER\n")}, nil)
	waitFor(t, "after attach", func() bool {
		out, _ := nt.output(t, id)
		return bytes.HasSuffix(out, []byte("AFTER\r\n")) || bytes.Contains(out[ackWindow:], []byte("AFTER"))
	})
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("exit\n")}, nil)
}

// 窓の中なら ack の度に続きが送られる。
func TestTermAckResumes(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)
	const total = 600 << 10
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("head -c 614400 /dev/zero | tr '\\0' 'b'; printf DONE; exit\n")}, nil)
	acked := int64(0)
	waitFor(t, "all output", func() bool {
		out, last := nt.output(t, id)
		if last > acked {
			acked = last
			c.Notify("term.ack", map[string]any{"termId": id, "seq": last})
		}
		return bytes.Contains(out, []byte("DONE")) && len(out) >= total
	})
	out, _ := nt.output(t, id)
	if n := bytes.Count(out, []byte("b")); n < total || n > total+8 { // 打ち込んだ行のエコーにも b がある
		t.Errorf("got %d b", n)
	}
	if _, last := nt.output(t, id); last != int64(len(out)) {
		t.Errorf("seq %d, bytes %d", last, len(out))
	}
}

func TestTermShutdownHangsUpShells(t *testing.T) {
	srv, sock := start(t)
	c, _ := termClient(t, sock)
	id := createTerm(t, c, nil)
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatal(err)
	}
	srv.Close()
	waitFor(t, "shell gone", func() bool { tm.mu.Lock(); defer tm.mu.Unlock(); return !tm.alive })
}

func TestOSCScan(t *testing.T) {
	var o oscScan
	for _, c := range []struct{ in, want string }{
		{"abc\x1b]0;one\x07", "one"},
		{"\x1b]2;tw", ""}, // 途中
		{"o\x1b\\", "two"},
		{"\x1b]133;D;0\x07", ""},
		{"\x1b[31m\x1b]0;a\x01b\x07", "ab"},
	} {
		got, ok := o.feed([]byte(c.in))
		if got != c.want || ok != (c.want != "") {
			t.Errorf("feed(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
}

// リングが溢れたあとも、ack すれば続きが流れる（捨てられた分は seq が飛ぶ）。
func TestTermResumesAfterOverflow(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("head -c 2097152 /dev/zero | tr '\\0' 'a'; printf END\n")}, nil)
	waitFor(t, "first window", func() bool { _, last := nt.output(t, id); return last >= ackWindow })
	var a attachResult
	waitFor(t, "overflow", func() bool {
		if err := c.Call(ctx, "term.attach", map[string]any{"termId": id}, &a); err != nil {
			t.Fatal(err)
		}
		return a.Seq >= 2<<20
	})
	// attach は末尾まで進めてしまうので、溢れを作り直す: もう 2 MiB 出して ack 無しで待つ。
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("head -c 2097152 /dev/zero | tr '\\0' 'c'; printf FIN\n")}, nil)
	waitFor(t, "window", func() bool { _, last := nt.output(t, id); return last > a.Seq })
	time.Sleep(300 * time.Millisecond)
	var acked int64
	waitFor(t, "FIN after acks", func() bool {
		out, last := nt.output(t, id)
		if last > acked {
			acked = last
			c.Notify("term.ack", map[string]any{"termId": id, "seq": last})
		}
		return bytes.Contains(out, []byte("FIN\r\n")) || bytes.HasSuffix(out, []byte("FIN"))
	})
}

// 分割したターミナルは 5 個まで（プライマリと合わせて 6 個）。
func TestTermSplitLimit(t *testing.T) {
	_, sock := start(t)
	c, _ := termClient(t, sock)
	id, _ := createWS(t, c)
	for range maxSplitTerms {
		createTerm(t, c, map[string]any{"workspaceId": id})
	}
	err := c.Call(context.Background(), "term.create", map[string]any{"workspaceId": id, "cols": 80, "rows": 24, "shell": "/bin/sh"}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeBusy {
		t.Errorf("6th split terminal: %v", err)
	}
	// ほかのワークスペースの数には入らない。
	createTerm(t, c, nil)
}

// プライマリターミナルは term.close で閉じられない。終わったら term.restart で新しいシェルが始まり、
// termId はそのまま。分割したターミナルに term.restart は送れない。動いているシェルにも送れない。
func TestTermPrimaryCloseAndRestart(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	split := createTerm(t, c, map[string]any{"workspaceId": id})

	if err := c.Call(ctx, "term.close", map[string]any{"termId": primary}, nil); !isCode(err, rpc.CodeDenied) {
		t.Errorf("close primary: %v", err)
	}
	if err := c.Call(ctx, "term.restart", map[string]any{"termId": split}, nil); !isCode(err, rpc.CodeDenied) {
		t.Errorf("restart split: %v", err)
	}
	if err := c.Call(ctx, "term.restart", map[string]any{"termId": primary}, nil); !isCode(err, rpc.CodeBusy) {
		t.Errorf("restart a running shell: %v", err)
	}

	c.Call(ctx, "term.input", map[string]any{"termId": primary, "data": b64("exit\n")}, nil)
	waitFor(t, "exit", func() bool { return nt.find("term.exit") != nil })
	// シェルが終わってもワークスペースは残る。
	var l wsList
	if err := c.Call(ctx, "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 || l.Workspaces[0].Primary != primary {
		t.Fatalf("list: %+v %v", l, err)
	}
	var r struct {
		PID int    `json:"pid"`
		Cwd string `json:"cwd"`
	}
	if err := c.Call(ctx, "term.restart", map[string]any{"termId": primary}, &r); err != nil || r.PID == 0 {
		t.Fatalf("restart: %+v %v", r, err)
	}
	c.Call(ctx, "term.input", map[string]any{"termId": primary, "data": b64("printf again-ok; exit 4\n")}, nil)
	waitFor(t, "second exit", func() bool {
		n := 0
		for _, raw := range nt.all("term.exit") {
			var e struct{ Code int }
			json.Unmarshal(*raw, &e)
			if e.Code == 4 {
				n++
			}
		}
		return n == 1
	})
	if out, _ := nt.output(t, primary); !bytes.Contains(out, []byte("again-ok")) {
		t.Errorf("output after restart: %q", out)
	}
}
