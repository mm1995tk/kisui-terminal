package server

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// fakeClock は差し替えられる時計。
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func startIdle(t *testing.T, idle time.Duration, clk *fakeClock) (*Server, string, chan struct{}) {
	t.Helper()
	dir, err := os.MkdirTemp("", "shjsrv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "serve.rpc")
	srv, err := Listen(Options{SocketPath: sock, IdleStop: idle, IdleCheck: 5 * time.Millisecond, Now: clk.now})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { srv.Serve(context.Background()); close(done) }()
	t.Cleanup(func() { srv.Close(); <-done })
	return srv, sock, done
}

func waitDone(t *testing.T, done chan struct{}, want bool) {
	t.Helper()
	select {
	case <-done:
		if !want {
			t.Fatal("server stopped")
		}
	case <-time.After(300 * time.Millisecond):
		if want {
			t.Fatal("server did not stop")
		}
	}
}

func TestIdleStop(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	srv, sock, done := startIdle(t, 7*24*time.Hour, clk)

	c := dial(t, sock)
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	var info InfoResult
	if err := c.Call(context.Background(), "server.info", struct{}{}, &info); err != nil {
		t.Fatal(err)
	}
	if info.IdleStopAt != nil {
		t.Fatalf("connected: idleStopAt must be null: %v", info.IdleStopAt)
	}
	// つながっている間は何日経っても止まらない。
	clk.add(30 * 24 * time.Hour)
	waitDone(t, done, false)

	c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for srv.idleStopAt() == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	at := srv.idleStopAt()
	if at == nil || !at.Equal(clk.now().Add(7*24*time.Hour)) {
		t.Fatalf("idleStopAt: %v", at)
	}
	clk.add(7*24*time.Hour - time.Second)
	waitDone(t, done, false)
	clk.add(time.Second)
	waitDone(t, done, true)
}

func TestIdleStopZeroNeverStops(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	srv, _, done := startIdle(t, 0, clk)
	clk.add(1000 * 24 * time.Hour)
	waitDone(t, done, false)
	if srv.idleStopAt() != nil {
		t.Fatal("idleStopAt must be null")
	}
}

func TestShutdown(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	_, sock, done := startIdle(t, 0, clk)
	c := dial(t, sock)
	ctx := context.Background()
	if err := c.Call(ctx, "server.shutdown", struct{}{}, nil); err == nil || err.(*rpc.Error).Code != rpc.CodeInvalidRequest {
		t.Fatalf("before hello: %v", err)
	}
	if err := c.Call(ctx, "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	createTerm(t, c, nil)
	err := c.Call(ctx, "server.shutdown", struct{}{}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeBusy {
		t.Fatalf("busy expected: %v", err)
	}
	waitDone(t, done, false)
	var r struct {
		Terminals int `json:"terminals"`
	}
	if err := c.Call(ctx, "server.shutdown", map[string]any{"force": true}, &r); err != nil {
		t.Fatal(err)
	}
	if r.Terminals != 2 { // プライマリターミナルと分割したターミナル
		t.Fatalf("terminals: %d", r.Terminals)
	}
	waitDone(t, done, true)
}

func TestShutdownWithoutTerminals(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	_, sock, done := startIdle(t, 0, clk)
	c := dial(t, sock)
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Call(context.Background(), "server.shutdown", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	waitDone(t, done, true)
}
