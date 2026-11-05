package server

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
)

// fakeCores is a Cores whose files the test sets.
type fakeCores struct {
	mu       sync.Mutex
	files    map[string][]string // id -> open files
	opened   []string            // ids, with the folder: "id=root"
	saved    []string
	released []string
	closed   []string
	renamed  []string // "from>to"
	openErr  error    // what Open returns
	failSave []string // what SaveAll cannot save
}

func (f *fakeCores) Open(id, root string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opened = append(f.opened, id+"="+root)
	return f.openErr
}

func (f *fakeCores) Files(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.files[id])
}

func (f *fakeCores) SaveAll(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saved = append(f.saved, id)
	return slices.Clone(f.failSave)
}

func (f *fakeCores) Release(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = append(f.released, id)
	delete(f.files, id)
}

func (f *fakeCores) Renamed(from, to string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renamed = append(f.renamed, from+">"+to)
}

func (f *fakeCores) Close(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = append(f.closed, id)
}

// count is how many times l has s in it.
func (f *fakeCores) count(l *[]string, s string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, x := range *l {
		if x == s {
			n++
		}
	}
	return n
}

// A workspace lists the files its core has open relative to its folder, and
// gets its core on focus (on its folder).
func TestWorkspaceListsFilesAndOpensCoreOnFocus(t *testing.T) {
	root := normalizePath(t.TempDir())
	srv, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	fc := &fakeCores{}
	srv.SetCores(fc)
	c, _ := termClient(t, sock)
	ctx := context.Background()
	id, primary := createWS(t, c)
	fc.mu.Lock()
	fc.files = map[string][]string{id: {root + "/pkg/a.go", "/elsewhere/b.go"}}
	fc.mu.Unlock()

	var l wsList
	waitFor(t, "files", func() bool {
		l = wsList{}
		c.Call(ctx, "workspace.list", map[string]any{}, &l)
		return len(l.Workspaces) == 1 && len(l.Workspaces[0].Files) == 2
	})
	x := l.Workspaces[0]
	if x.Folder == nil || *x.Folder != root || *x.Kind != "cwd" || x.Primary != primary || len(x.Terms) != 0 ||
		!slices.Equal(x.Files, []string{"pkg/a.go", "/elsewhere/b.go"}) {
		t.Fatalf("workspace: %+v", x)
	}

	var f struct {
		TermID string `json:"termId"`
	}
	if err := c.Call(ctx, "workspace.focus", map[string]any{"id": id}, &f); err != nil {
		t.Fatal(err)
	}
	if fc.count(&fc.opened, id+"="+root) != 1 || f.TermID != primary {
		t.Errorf("focus: opened %v, termId %q", fc.opened, f.TermID)
	}
}

// A workspace whose core cannot be made (its configuration has a mistake) does
// not take the focus, and the reason reaches the client.
func TestWorkspaceFocusFailsWhenCoreCannotBeMade(t *testing.T) {
	root := normalizePath(t.TempDir())
	srv, sock := startFastWith(t, func(o *Options) { o.StartDir = root })
	srv.SetCores(&fakeCores{openErr: errors.New("config.toml:2: unknown key")})
	c, _ := termClient(t, sock)
	id, _ := createWS(t, c)
	err := c.Call(context.Background(), "workspace.focus", map[string]any{"id": id}, nil)
	if err == nil || !strings.Contains(err.Error(), "config.toml:2: unknown key") {
		t.Fatalf("err = %v", err)
	}
}
