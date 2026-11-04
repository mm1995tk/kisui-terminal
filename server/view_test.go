package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/mm1995tk/shijimi-editor/core/msg"
	"github.com/mm1995tk/shijimi-editor/core/screen"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
	"github.com/mm1995tk/shijimi-editor/ui/internal/i18n"
)

// fakeScreens is a Screens whose screen the test sets.
type fakeScreens struct {
	mu    sync.Mutex
	sc    screen.Screen
	view  screen.View // the last size asked for
	theme Theme
	blobs map[string][]byte
}

func (f *fakeScreens) Screen(_ string, v screen.View) (screen.Screen, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.view = v
	// a copy, so the test can change its own afterwards
	b, _ := json.Marshal(f.sc)
	var out screen.Screen
	json.Unmarshal(b, &out)
	return out, true
}

func (f *fakeScreens) Theme(string) (Theme, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.theme, true
}

func (f *fakeScreens) Blob(_, id string) (string, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.blobs[id]
	if !ok {
		return "", nil, ErrNoBlob
	}
	return "image/png", d, nil
}

func (f *fakeScreens) set(fn func(sc *screen.Screen)) {
	f.mu.Lock()
	fn(&f.sc)
	f.mu.Unlock()
}

func textLines(texts ...string) []screen.Line {
	var out []screen.Line
	for i, s := range texts {
		out = append(out, screen.Line{No: i, Spans: []screen.Span{{Text: s}}})
	}
	return out
}

// update is the part of screen.update the tests read.
type update struct {
	Rev     int64          `json:"rev"`
	BaseRev int64          `json:"baseRev"`
	Focus   *string        `json:"focus"`
	Status  *screen.Status `json:"status"`
	Cmdline *struct{}      `json:"cmdline"`
	Overlay *[]any         `json:"overlay"`
	Files   *struct {
		Active *int `json:"active"`
		Panes  []struct {
			ID       string           `json:"id"`
			Title    *screen.Title    `json:"title"`
			Viewport *screen.Viewport `json:"viewport"`
			Lines    *struct {
				Rows  map[string]screen.Line `json:"rows"`
				Count int                    `json:"count"`
			} `json:"lines"`
		} `json:"panes"`
	} `json:"files"`
	raw map[string]json.RawMessage
}

func (n *notes) updates(t *testing.T) []update {
	t.Helper()
	var out []update
	for _, raw := range n.all("screen.update") {
		var u update
		if err := json.Unmarshal(*raw, &u); err != nil {
			t.Fatal(err)
		}
		json.Unmarshal(*raw, &u.raw)
		out = append(out, u)
	}
	return out
}

// screenSetup starts a server with a workspace whose screen fs gives, and a GUI
// focused on it that subscribes to the regions the GUI shows.
func screenSetup(t *testing.T) (*Server, *rpc.Conn, *notes, *fakeScreens) {
	t.Helper()
	root := normalizePath(t.TempDir())
	srv, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	fcs := &fakeCores{}
	srv.SetCores(fcs)
	fs := &fakeScreens{
		sc: screen.Screen{
			Focus: screen.RegionFiles,
			Files: &screen.Files{Panes: []screen.Pane{{
				ID: "a.txt", Kind: screen.KindText, Title: screen.Title{Text: "a.txt"},
				Viewport: screen.Viewport{Rows: 4, Cols: 40, Total: 4},
				Lines:    textLines("one", "two", "three", "four"),
			}}},
			Status: screen.Status{Mode: "NOR", Position: msg.S("1:1")},
		},
		theme: ThemeOf("dark", screen.Palette{screen.StyleSyntaxKeyword: "#569cd6"}),
		blobs: map[string][]byte{"file:/x.png": []byte("0123456789")},
	}
	srv.SetScreens(fs)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id, _ := createWS(t, c)
	fcs.mu.Lock()
	fcs.files = map[string][]string{id: {filepath.Join(root, "a.txt")}}
	fcs.mu.Unlock()
	if err := c.Call(ctx, "workspace.focus", map[string]any{"id": id}, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Call(ctx, "view.subscribe", map[string]any{"regions": []string{"files", "status", "cmdline", "overlay"}}, nil); err != nil {
		t.Fatal(err)
	}
	return srv, c, nt, fs
}

func waitUpdates(t *testing.T, nt *notes, n int) []update {
	t.Helper()
	waitFor(t, strconv.Itoa(n)+" screen.update", func() bool { return len(nt.all("screen.update")) >= n })
	return nt.updates(t)
}

func ack(t *testing.T, c *rpc.Conn, rev int64) {
	t.Helper()
	if err := c.Notify("screen.ack", map[string]any{"rev": rev}); err != nil {
		t.Fatal(err)
	}
}

// The first update has everything; typing a character sends only the line
// that changed and the status line.
func TestScreenUpdateSendsChangedLines(t *testing.T) {
	srv, c, nt, fs := screenSetup(t)
	first := waitUpdates(t, nt, 1)[0]
	if first.BaseRev != 0 || first.Files == nil || first.Status == nil || first.Focus == nil {
		t.Fatalf("first update is not whole: %+v", first.raw)
	}
	if _, ok := first.raw["cmdline"]; !ok {
		t.Error("first update must say there is no cmdline")
	}
	p := first.Files.Panes[0]
	if p.Lines == nil || len(p.Lines.Rows) != 4 || p.Lines.Count != 4 || p.Title == nil || p.Viewport == nil {
		t.Fatalf("first pane is not whole: %+v", p)
	}
	ack(t, c, first.Rev)

	fs.set(func(sc *screen.Screen) {
		sc.Files.Panes[0].Lines[1].Spans[0].Text = "twXo"
		sc.Status.Position = msg.S("2:4")
	})
	srv.ScreenChanged()
	u := waitUpdates(t, nt, 2)[1]
	if u.BaseRev != first.Rev || u.Rev <= first.Rev {
		t.Errorf("revs: base %d rev %d after %d", u.BaseRev, u.Rev, first.Rev)
	}
	keys := slices.Sorted(func(yield func(string) bool) {
		for k := range u.raw {
			if !yield(k) {
				return
			}
		}
	})
	if !slices.Equal(keys, []string{"ackSeq", "baseRev", "files", "rev", "status"}) {
		t.Errorf("update has %v", keys)
	}
	if i18n.Text(u.Status.Position) != "2:4" {
		t.Errorf("status: %+v", u.Status)
	}
	p = u.Files.Panes[0]
	if p.ID != "a.txt" || p.Title != nil || p.Viewport != nil || p.Lines == nil || len(p.Lines.Rows) != 1 || p.Lines.Rows["1"].Spans[0].Text != "twXo" {
		t.Errorf("pane: %+v", p)
	}
}

// While an update waits for screen.ack, the changes pile up into one update
// sent when the ack comes.
func TestScreenUpdatesWaitForAck(t *testing.T) {
	srv, c, nt, fs := screenSetup(t)
	first := waitUpdates(t, nt, 1)[0]

	fs.set(func(sc *screen.Screen) { sc.Files.Panes[0].Lines[0].Spans[0].Text = "ONE" })
	srv.ScreenChanged()
	fs.set(func(sc *screen.Screen) { sc.Files.Panes[0].Lines[3].Spans[0].Text = "FOUR" })
	srv.ScreenChanged()
	time.Sleep(100 * time.Millisecond)
	if n := len(nt.all("screen.update")); n != 1 {
		t.Fatalf("%d updates before the ack", n)
	}
	ack(t, c, first.Rev)
	u := waitUpdates(t, nt, 2)[1]
	rows := u.Files.Panes[0].Lines.Rows
	if len(rows) != 2 || rows["0"].Spans[0].Text != "ONE" || rows["3"].Spans[0].Text != "FOUR" {
		t.Errorf("rows: %+v", rows)
	}
	if u.BaseRev != first.Rev {
		t.Errorf("baseRev %d, want %d", u.BaseRev, first.Rev)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(nt.all("screen.update")); n != 2 {
		t.Errorf("%d updates, want 2", n)
	}
}

// A GUI that lost an update gets the whole screen with screen.get, and the
// updates after it build on that screen.
func TestScreenGetRecovers(t *testing.T) {
	srv, c, nt, fs := screenSetup(t)
	ctx := context.Background()
	first := waitUpdates(t, nt, 1)[0]
	ack(t, c, first.Rev)
	fs.set(func(sc *screen.Screen) { sc.Status.Msg = msg.S("saved") })
	srv.ScreenChanged()
	lost := waitUpdates(t, nt, 2)[1]

	// The GUI missed lost (it still holds first.Rev), so the next update's
	// baseRev would not match: it asks for the whole screen.
	var sc screen.Screen
	if err := c.Call(ctx, "screen.get", map[string]any{}, &sc); err != nil {
		t.Fatal(err)
	}
	if int64(sc.Rev) != lost.Rev || i18n.Text(sc.Status.Msg) != "saved" || sc.Files == nil || len(sc.Files.Panes[0].Lines) != 4 {
		t.Fatalf("screen.get: rev %d (lost %d) %+v", sc.Rev, lost.Rev, sc.Status)
	}
	fs.set(func(sc *screen.Screen) { sc.Status.Msg = msg.S("") })
	srv.ScreenChanged()
	u := waitUpdates(t, nt, 3)[2]
	if u.BaseRev != int64(sc.Rev) || u.Status == nil || u.Files != nil {
		t.Errorf("after screen.get: %+v", u.raw)
	}
}

// Scrolling sends every row; a resize reaches the core.
func TestScreenScrollAndResize(t *testing.T) {
	srv, c, nt, fs := screenSetup(t)
	ctx := context.Background()
	first := waitUpdates(t, nt, 1)[0]
	ack(t, c, first.Rev)
	fs.set(func(sc *screen.Screen) {
		p := &sc.Files.Panes[0]
		p.Viewport.Top = 1
		p.Lines = append(textLines("zero", "one", "two", "three")[1:], screen.Line{No: 4, Spans: []screen.Span{{Text: "four"}}})
		for i := range p.Lines {
			p.Lines[i].No = i + 1
		}
		p.Lines[0].Spans[0].Text = "one" // the same text as row 0 had, on another line
	})
	srv.ScreenChanged()
	u := waitUpdates(t, nt, 2)[1]
	if rows := u.Files.Panes[0].Lines.Rows; len(rows) != 4 {
		t.Errorf("scroll sent %d rows", len(rows))
	}
	ack(t, c, u.Rev)

	err := c.Call(ctx, "view.resize", map[string]any{"regions": map[string]any{"files": map[string]int{"cols": 100, "rows": 30}, "status": map[string]int{"cols": 100}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "resize", func() bool {
		fs.mu.Lock()
		defer fs.mu.Unlock()
		return fs.view.Files == screen.Size{Cols: 100, Rows: 30} && fs.view.Status.Cols == 100
	})
	if err := c.Call(ctx, "view.subscribe", map[string]any{"regions": []string{"explorer"}}, nil); !isCode(err, rpc.CodeInvalidParams) {
		t.Errorf("explorer subscribed: %v", err)
	}
	if err := c.Call(ctx, "view.resize", map[string]any{"regions": map[string]any{"agent": map[string]int{"cols": 1}}}, nil); !isCode(err, rpc.CodeInvalidParams) {
		t.Errorf("agent resized: %v", err)
	}
}

func isCode(err error, code int) bool {
	e, ok := err.(*rpc.Error)
	return ok && e.Code == code
}

// theme.get gives the colors by name; a change of theme comes as
// theme.changed before the screen.
func TestThemeGetAndChanged(t *testing.T) {
	srv, c, nt, fs := screenSetup(t)
	ctx := context.Background()
	first := waitUpdates(t, nt, 1)[0]
	ack(t, c, first.Rev)
	var th Theme
	if err := c.Call(ctx, "theme.get", map[string]any{}, &th); err != nil {
		t.Fatal(err)
	}
	if th.Name != "dark" || th.Tokens[screen.StyleSyntaxKeyword].Fg != "#569cd6" {
		t.Fatalf("theme: %+v", th)
	}
	fs.mu.Lock()
	fs.theme = ThemeOf("light", screen.Palette{screen.StyleSyntaxKeyword: "#0000ff"})
	fs.mu.Unlock()
	fs.set(func(sc *screen.Screen) { sc.Status.Msg = msg.S("theme") })
	srv.ScreenChanged()
	waitFor(t, "theme.changed", func() bool { return len(nt.all("theme.changed")) == 1 })
	json.Unmarshal(*nt.all("theme.changed")[0], &th)
	if th.Name != "light" || th.Tokens[screen.StyleSyntaxKeyword].Fg != "#0000ff" {
		t.Errorf("theme.changed: %+v", th)
	}
}

// blob.get gives an image in pieces; one the screen does not show is not found.
func TestBlobGet(t *testing.T) {
	_, c, _, _ := screenSetup(t)
	ctx := context.Background()
	var got []byte
	off := 0
	for {
		var r BlobResult
		if err := c.Call(ctx, "blob.get", map[string]any{"id": "file:/x.png", "offset": off, "length": 4}, &r); err != nil {
			t.Fatal(err)
		}
		d, _ := base64.StdEncoding.DecodeString(r.Data)
		if r.Mime != "image/png" || r.Size != 10 {
			t.Fatalf("blob: %+v", r)
		}
		got = append(got, d...)
		off += len(d)
		if r.EOF {
			break
		}
		if len(d) == 0 {
			t.Fatal("no progress")
		}
	}
	if string(got) != "0123456789" {
		t.Errorf("blob = %q", got)
	}
	if err := c.Call(ctx, "blob.get", map[string]any{"id": "file:/etc/passwd"}, nil); !isCode(err, rpc.CodeNotFound) {
		t.Errorf("unknown blob: %v", err)
	}
}

// i18n.get gives the table of the language; a message goes to the GUI as its
// key and values, and a change of language comes as i18n.changed.
func TestI18nGetAndMsgOnTheWire(t *testing.T) {
	t.Cleanup(func() { i18n.SetLang(i18n.Default) })
	srv, c, nt, fs := screenSetup(t)
	ctx := context.Background()
	first := waitUpdates(t, nt, 1)[0]
	ack(t, c, first.Rev)
	var tb I18n
	if err := c.Call(ctx, "i18n.get", map[string]any{}, &tb); err != nil {
		t.Fatal(err)
	}
	if tb.Lang != "en" || tb.Messages["acp.notfound"] != "%s not found" {
		t.Fatalf("i18n.get: %s %q", tb.Lang, tb.Messages["acp.notfound"])
	}
	fs.set(func(sc *screen.Screen) { sc.Status.Msg = msg.T("acp.notfound", "claude") })
	srv.ScreenChanged()
	waitUpdates(t, nt, 2)
	var raw struct {
		Status struct {
			Msg struct {
				Key  string `json:"key"`
				Args []any  `json:"args"`
			} `json:"msg"`
		} `json:"status"`
	}
	if err := json.Unmarshal(*nt.all("screen.update")[1], &raw); err != nil {
		t.Fatal(err)
	}
	if raw.Status.Msg.Key != "acp.notfound" || len(raw.Status.Msg.Args) != 1 || raw.Status.Msg.Args[0] != "claude" {
		t.Errorf("status.msg: %+v", raw.Status.Msg)
	}
	ack(t, c, waitUpdates(t, nt, 2)[1].Rev)

	srv.SetLanguage("ja")
	waitFor(t, "i18n.changed", func() bool { return len(nt.all("i18n.changed")) == 1 })
	if err := json.Unmarshal(*nt.all("i18n.changed")[0], &tb); err != nil {
		t.Fatal(err)
	}
	if tb.Lang != "ja" || tb.Messages["acp.notfound"] == "%s not found" {
		t.Errorf("i18n.changed: %s %q", tb.Lang, tb.Messages["acp.notfound"])
	}
}
