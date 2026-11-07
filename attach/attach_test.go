package attach

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// echoServer は受けたバイトをそのまま返すソケットを作る。
func echoServer(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	return ln
}

func TestRunBridgesToRunningServer(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "s")
	ln := echoServer(t, sock)
	defer ln.Close()
	pr, pw := io.Pipe()
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- Run(Options{SocketPath: sock, LockPath: filepath.Join(dir, "l"),
			Start: func() error { t.Error("started"); return nil }, In: pr, Out: &syncWriter{w: &out}})
	}()
	pw.Write([]byte("hello"))
	deadline := time.Now().Add(2 * time.Second)
	for !strings.HasSuffix(out.String(), "hello") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := out.String(); got != Marker+"hello" {
		t.Fatalf("out = %q", got)
	}
	pw.Close()
	<-done
}

// Info があれば、目印のすぐあと、serve の出力より前に attach.info を 1 行で出す。
func TestRunWritesInfoAfterMarker(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "s")
	ln := echoServer(t, sock)
	defer ln.Close()
	pr, pw := io.Pipe()
	var out bytes.Buffer
	done := make(chan error, 1)
	info := &Info{Executable: "/opt/kisui", Version: "1.2.3", Commit: "abc", Channel: "stable",
		Env: map[string]string{"KISUI_SHJ_DIR": "/opt/shj"}}
	go func() {
		done <- Run(Options{SocketPath: sock, LockPath: filepath.Join(dir, "l"), Info: info,
			Start: func() error { t.Error("started"); return nil }, In: pr, Out: &syncWriter{w: &out}})
	}()
	pw.Write([]byte("hello"))
	deadline := time.Now().Add(2 * time.Second)
	for !strings.HasSuffix(out.String(), "hello") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	want := Marker +
		`{"jsonrpc":"2.0","method":"attach.info","params":{"executable":"/opt/kisui","version":"1.2.3","commit":"abc","channel":"stable","env":{"KISUI_SHJ_DIR":"/opt/shj"}}}` +
		"\n" + "hello"
	if got := out.String(); got != want {
		t.Fatalf("out = %q\nwant  %q", got, want)
	}
	pw.Close()
	<-done
}

type syncWriter struct {
	mu sync.Mutex
	w  *bytes.Buffer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}

// 2 つ同時に attach しても、起動は 1 回だけ。サーバーはどちらにも残る。
func TestConcurrentAttachStartsOnce(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "s")
	var starts atomic.Int32
	var ln net.Listener
	start := func() error {
		starts.Add(1)
		time.Sleep(100 * time.Millisecond) // 起動に時間がかかる
		var err error
		ln, err = net.Listen("unix", sock)
		if err != nil {
			return err
		}
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
		return nil
	}
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			var out bytes.Buffer
			err := Run(Options{SocketPath: sock, LockPath: filepath.Join(dir, "l"),
				Start: start, In: strings.NewReader(""), Out: &out, Poll: 10 * time.Millisecond})
			if err != nil && err != io.EOF {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n := starts.Load(); n != 1 {
		t.Fatalf("starts = %d, want 1", n)
	}
	// 終えても残っていて、もう一度つながる。
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	ln.Close()
}

func TestStartTimeout(t *testing.T) {
	dir := t.TempDir()
	err := Run(Options{SocketPath: filepath.Join(dir, "s"), LockPath: filepath.Join(dir, "l"),
		Start: func() error { return nil }, WaitTimeout: 100 * time.Millisecond, Poll: 10 * time.Millisecond,
		In: strings.NewReader(""), Out: io.Discard})
	if err == nil {
		t.Fatal("want error")
	}
	_ = os.Remove
}

// kisui serve が起動できずに終わったら、待ちきる前にその理由を返す。
func TestRunReportsWhyServeExited(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	start := time.Now()
	err := Run(Options{
		SocketPath: filepath.Join(dir, "s"), LockPath: filepath.Join(dir, "l"),
		Start:       func() error { return nil },
		Exited:      func() (string, bool) { return "config.toml:3: unknown key", true },
		WaitTimeout: 5 * time.Second,
		In:          strings.NewReader(""), Out: &out,
	})
	var se *StartError
	if !errors.As(err, &se) || se.Reason != "config.toml:3: unknown key" {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("it waited for the timeout")
	}
}
