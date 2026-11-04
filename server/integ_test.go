package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mm1995tk/shijimi-editor/core"
	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/ui/cli/ctlclient"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

type fakeWS struct {
	name string
	reqs chan ctl.Request
}

func (w *fakeWS) Control(r ctl.Request) ctl.Response {
	w.reqs <- r
	return ctl.Response{OK: true, Message: w.name}
}

func (w *fakeWS) IDE(_ context.Context, tool string, _ json.RawMessage) ([]core.IDEContent, error) {
	return []core.IDEContent{core.IDEText(w.name + ":" + tool)}, nil
}

func TestControlReachesFocusedWorkspace(t *testing.T) {
	srv, _ := start(t)
	dir, err := os.MkdirTemp("", "shjctl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "1.sock")
	if err := srv.StartControl(sock); err != nil {
		t.Fatal(err)
	}
	t.Setenv(ctl.EnvSocket, sock)

	// No workspace has the focus yet.
	if resp, err := ctlclient.Call(ctl.Request{Cmd: "diff"}); err != nil || resp.OK || resp.Error == "" {
		t.Fatalf("no focus: %+v %v", resp, err)
	}

	a := &fakeWS{name: "a", reqs: make(chan ctl.Request, 1)}
	b := &fakeWS{name: "b", reqs: make(chan ctl.Request, 1)}
	srv.SetFocus(a)
	resp, err := ctlclient.Call(ctl.Request{Cmd: "diff", Path: "/x"})
	if err != nil || !resp.OK || resp.Message != "a" {
		t.Fatalf("a: %+v %v", resp, err)
	}
	if r := <-a.reqs; r.Cmd != "diff" || r.Path != "/x" {
		t.Fatalf("a got %+v", r)
	}
	srv.SetFocus(b)
	resp, err = ctlclient.Call(ctl.Request{Cmd: "exec", Line: "theme"})
	if err != nil || resp.Message != "b" {
		t.Fatalf("b: %+v %v", resp, err)
	}
	if r := <-b.reqs; r.Cmd != "exec" {
		t.Fatalf("b got %+v", r)
	}
	if len(a.reqs) != 0 {
		t.Fatal("a got b's request")
	}
}

func TestIDEReachesFocusedWorkspace(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	srv, _ := start(t)
	is, err := srv.StartIDE(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d := websocket.Dialer{Subprotocols: []string{"mcp"}}
	c, _, err := d.Dial(fmt.Sprintf("ws://127.0.0.1:%d", is.Port()), http.Header{core.IDEAuthHeader: {is.Token()}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	call := func(id int) map[string]any {
		t.Helper()
		if err := c.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": "getOpenEditors"}}); err != nil {
			t.Fatal(err)
		}
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		var m map[string]any
		if err := c.ReadJSON(&m); err != nil {
			t.Fatal(err)
		}
		return m["result"].(map[string]any)
	}
	if r := call(1); r["isError"] != true {
		t.Fatalf("no focus must be an error: %v", r)
	}
	srv.SetFocus(&fakeWS{name: "a"})
	r := call(2)
	if text := r["content"].([]any)[0].(map[string]any)["text"]; text != "a:getOpenEditors" {
		t.Fatalf("got %v", r)
	}
}

func TestClipboardAndURLNotifyGUI(t *testing.T) {
	srv, sock := start(t)
	// Nobody is connected yet: dropped without a panic.
	srv.WriteClipboard("early")

	n := &notes{}
	nc, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c := rpc.NewConn(nc, rpc.JSON{}, n.handle)
	t.Cleanup(func() { c.Close() })
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	srv.WriteClipboard("copied")
	srv.OpenURL("https://example.com")
	want := map[string]string{"clipboard.write": `{"text":"copied"}`, "url.open": `{"url":"https://example.com"}`}
	deadline := time.Now().Add(3 * time.Second)
	for len(want) > 0 && time.Now().Before(deadline) {
		n.mu.Lock()
		for _, m := range n.got {
			if w, ok := want[m.Method]; ok && string(m.Params) == w {
				delete(want, m.Method)
			}
		}
		n.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	if len(want) > 0 {
		t.Fatalf("missing %v", want)
	}
}
