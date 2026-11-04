package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/mm1995tk/shijimi-editor/core/screen"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// fakeInputs is an Inputs that types a key's text at the end of the second
// line of fs's screen and remembers what it got.
type fakeInputs struct {
	fs     *fakeScreens
	mu     sync.Mutex
	keys   []KeyInput
	mouse  []MouseInput
	opened []string
}

func (f *fakeInputs) Key(_ string, in KeyInput) {
	f.mu.Lock()
	f.keys = append(f.keys, in)
	f.mu.Unlock()
	if in.Phase != "release" && in.Text != "" {
		f.fs.set(func(sc *screen.Screen) { sc.Files.Panes[0].Lines[1].Spans[0].Text += in.Text })
	}
}
func (f *fakeInputs) Composition(string, CompositionInput) {}
func (f *fakeInputs) Mouse(_ string, in MouseInput) {
	f.mu.Lock()
	f.mouse = append(f.mouse, in)
	f.mu.Unlock()
}
func (f *fakeInputs) Paste(string, PasteInput) {}
func (f *fakeInputs) Focus(string, FocusInput) {}
func (f *fakeInputs) Command(_, line string) (bool, string) {
	if line == "bad" {
		return false, "unknown command"
	}
	return true, "ran " + line
}
func (f *fakeInputs) OpenFile(_, _, path string, _ *screen.Pos, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opened = append(f.opened, path)
	return nil
}

func inputSetup(t *testing.T) (*rpc.Conn, *notes, *fakeInputs, wsInfo) {
	t.Helper()
	srv, c, nt, fs := screenSetup(t)
	in := &fakeInputs{fs: fs}
	srv.SetInputs(in)
	var l wsList
	if err := c.Call(context.Background(), "workspace.list", map[string]any{}, &l); err != nil || len(l.Workspaces) != 1 {
		t.Fatalf("workspaces: %+v %v", l, err)
	}
	return c, nt, in, l.Workspaces[0]
}

func ackSeqOf(t *testing.T, u update) int64 {
	t.Helper()
	var n int64
	if err := json.Unmarshal(u.raw["ackSeq"], &n); err != nil {
		t.Fatalf("ackSeq: %s", u.raw["ackSeq"])
	}
	return n
}

// A key reaches the focused workspace's core, and the screen.update that has
// it says so with ackSeq. An input that changes nothing on the screen is
// acknowledged too, with an update that has nothing else.
func TestInputKeyCatchesUpAckSeq(t *testing.T) {
	c, nt, in, _ := inputSetup(t)
	ctx := context.Background()
	first := waitUpdates(t, nt, 1)[0]
	ack(t, c, first.Rev)

	var res struct {
		Rev int64 `json:"rev"`
	}
	if err := c.Call(ctx, "input.key", map[string]any{"seq": 1, "region": "files", "key": "x", "mods": []string{}, "text": "x", "phase": "press"}, &res); err != nil {
		t.Fatal(err)
	}
	u := waitUpdates(t, nt, 2)[1]
	if ackSeqOf(t, u) != 1 || res.Rev != u.Rev {
		t.Errorf("ackSeq %s, rev %d (update %d)", u.raw["ackSeq"], res.Rev, u.Rev)
	}
	if u.Files == nil || u.Files.Panes[0].Lines.Rows["1"].Spans[0].Text != "twox" {
		t.Errorf("update: %s", u.raw["files"])
	}
	ack(t, c, u.Rev)

	if err := c.Call(ctx, "input.key", map[string]any{"seq": 2, "region": "files", "key": "x", "mods": []string{}, "phase": "release"}, nil); err != nil {
		t.Fatal(err)
	}
	u = waitUpdates(t, nt, 3)[2]
	if ackSeqOf(t, u) != 2 || u.Files != nil || u.Status != nil {
		t.Errorf("update for an input that changed nothing: %+v", u.raw)
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if len(in.keys) != 2 || in.keys[0].Key != "x" || in.keys[0].Seq != 1 || in.keys[1].Phase != "release" {
		t.Errorf("keys: %+v", in.keys)
	}
}

// Inputs are checked before they reach the core.
func TestInputInvalidParams(t *testing.T) {
	c, _, in, _ := inputSetup(t)
	ctx := context.Background()
	for _, p := range []struct {
		method string
		params map[string]any
	}{
		{"input.key", map[string]any{"seq": 1, "region": "nowhere", "key": "a"}},
		{"input.key", map[string]any{"seq": 1, "region": "files", "key": "a", "phase": "hold"}},
		{"input.mouse", map[string]any{"seq": 1, "region": "files", "kind": "fly", "row": 0, "col": 0}},
		{"input.paste", map[string]any{"seq": 1, "region": 3}},
	} {
		if err := c.Call(ctx, p.method, p.params, nil); !isCode(err, rpc.CodeInvalidParams) {
			t.Errorf("%s %v: %v", p.method, p.params, err)
		}
	}
	if err := c.Call(ctx, "input.mouse", map[string]any{"seq": 2, "region": "files", "pane": "a.txt", "kind": "down", "button": 0, "clicks": 1, "row": 1, "col": 2, "mods": []string{}}, nil); err != nil {
		t.Fatal(err)
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if len(in.keys) != 0 || len(in.mouse) != 1 || in.mouse[0].Pane != "a.txt" || *in.mouse[0].Button != 0 || in.mouse[0].Row != 1 {
		t.Errorf("got keys %+v, mouse %+v", in.keys, in.mouse)
	}
}

// command.run answers as the control socket's exec does.
func TestCommandRun(t *testing.T) {
	c, _, _, _ := inputSetup(t)
	ctx := context.Background()
	var res struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	if err := c.Call(ctx, "command.run", map[string]any{"seq": 1, "line": "w"}, &res); err != nil || !res.OK || res.Message != "ran w" {
		t.Errorf("w: %+v %v", res, err)
	}
	if err := c.Call(ctx, "command.run", map[string]any{"seq": 2, "line": "bad"}, &res); err != nil || res.OK || res.Message != "unknown command" {
		t.Errorf("bad: %+v %v", res, err)
	}
}

// file.open opens a file of the workspace by its path from the root, and
// nothing outside it.
func TestFileOpen(t *testing.T) {
	c, _, in, ws := inputSetup(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(*ws.Folder, "a.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Mkdir(filepath.Join(*ws.Folder, "dir"), 0o755)
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "s.txt"), []byte("s\n"), 0o644)
	if err := os.Symlink(filepath.Join(outside, "s.txt"), filepath.Join(*ws.Folder, "link.txt")); err != nil {
		t.Fatal(err)
	}
	open := func(path string) error {
		return c.Call(ctx, "file.open", map[string]any{"seq": 1, "workspaceId": ws.ID, "path": path, "line": 0}, nil)
	}
	if err := open("a.txt"); err != nil {
		t.Fatal(err)
	}
	for path, code := range map[string]int{
		"../x":        rpc.CodeDenied,
		"/etc/passwd": rpc.CodeDenied,
		"link.txt":    rpc.CodeDenied,
		"missing.txt": rpc.CodeNotFound,
		"dir":         rpc.CodeInvalidParams,
		"":            rpc.CodeInvalidParams,
	} {
		if err := open(path); !isCode(err, code) {
			t.Errorf("%q: %v, want %d", path, err, code)
		}
	}
	if err := c.Call(ctx, "file.open", map[string]any{"seq": 2, "workspaceId": "nope", "path": "a.txt"}, nil); !isCode(err, rpc.CodeNotFound) {
		t.Errorf("no such workspace: %v", err)
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if len(in.opened) != 1 || in.opened[0] != filepath.Join(*ws.Folder, "a.txt") {
		t.Errorf("opened %v", in.opened)
	}
}

// Without anything that takes input, input.* is not_found.
func TestInputWithoutInputs(t *testing.T) {
	_, c, _, _ := screenSetup(t)
	err := c.Call(context.Background(), "input.key", map[string]any{"seq": 1, "region": "files", "key": "a"}, nil)
	var re *rpc.Error
	if !errors.As(err, &re) || re.Code != rpc.CodeNotFound {
		t.Errorf("got %v", err)
	}
}
