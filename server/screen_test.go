package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

func testFeed(t *testing.T, rows, cols int) *screenFeed {
	t.Helper()
	f := newScreenFeed(slog.New(slog.NewTextHandler(io.Discard, nil)), rows, cols)
	t.Cleanup(f.close)
	return f
}

// emulator は wait のあとに限って安全に読める（feeder が作り終えるのを待つ）。
func (f *screenFeed) emulator(t *testing.T) (row, col, rows, cols int) {
	t.Helper()
	f.wait()
	f.mu.Lock()
	em := f.em
	f.mu.Unlock()
	if em == nil {
		t.Fatal("no emulator")
	}
	var err error
	if row, col, err = em.Cursor(); err != nil {
		t.Fatal(err)
	}
	if rows, cols, err = em.Size(); err != nil {
		t.Fatal(err)
	}
	return
}

func TestScreenFeedKeepsStateInOrder(t *testing.T) {
	f := testFeed(t, 24, 80)
	f.write([]byte("ab\r\ncd"))
	f.resize(30, 100)
	f.write([]byte("e"))
	row, col, rows, cols := f.emulator(t)
	if row != 1 || col != 3 || rows != 30 || cols != 100 {
		t.Errorf("cursor %d,%d size %dx%d, want 1,3 30x100", row, col, rows, cols)
	}
}

// 追いつけないほど速く出力が来ても write は待たず、溜まった分は捨てて始めの状態に戻る。
func TestScreenFeedOverflowDropsInsteadOfBlocking(t *testing.T) {
	f := testFeed(t, 24, 80)
	chunk := bytes.Repeat([]byte("y\n"), 16<<10)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 4 * maxScreenPending / len(chunk) {
			f.write(chunk)
		}
	}()
	<-done
	f.wait()
	if f.lost.Load() == 0 {
		t.Skip("the emulator kept up with the writer; nothing was dropped on this machine")
	}
	f.write([]byte("\x1b[2J\x1b[Hok"))
	row, col, _, _ := f.emulator(t)
	if row != 0 || col != 2 {
		t.Errorf("after overflow the emulator did not recover: cursor %d,%d", row, col)
	}
}

// serve の中のエミュレーターは、問い合わせに返事を作っても、シェルにも GUI にも送らない。
// 返事を作ったこと（dropped）と、PTY への入力にも term.output にもその返事が出ないことを確かめる。
func TestTermScreenRepliesGoNowhere(t *testing.T) {
	srv, sock := start(t)
	c, nt := termClient(t, sock)
	id := createTerm(t, c, nil)
	ctx := context.Background()
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatal(err)
	}
	// DA1・DECRQM・kitty のキーボードの問い合わせを出す。返事が PTY に入ると、tty の echo で ^[ になって出力に出る
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64(`printf '\033[c\033[?2026$p\033[?u'; sleep 0.3; echo SENTINEL; exit` + "\n")}, nil)
	waitFor(t, "exit", func() bool { return nt.find("term.exit") != nil })
	tm.feed.wait()
	if tm.feed.dropped.Load() == 0 {
		t.Fatal("the emulator made no reply, so this does not test the drop")
	}
	out, _ := nt.output(t, id)
	if !strings.Contains(string(out), "SENTINEL") {
		t.Fatalf("no sentinel: %q", out)
	}
	if strings.Contains(string(out), "^[") {
		t.Errorf("a reply reached the shell or the GUI: %q", out)
	}
}

func TestTermScreenFollowsResize(t *testing.T) {
	srv, sock := start(t)
	c, _ := termClient(t, sock)
	id := createTerm(t, c, nil)
	ctx := context.Background()
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Call(ctx, "term.resize", map[string]any{"termId": id, "cols": 100, "rows": 30}, nil); err != nil {
		t.Fatal(err)
	}
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("printf 'zz'; sleep 0.2\n")}, nil)
	waitFor(t, "output reaches the emulator", func() bool {
		tm.feed.wait()
		row, _, rows, cols := tm.feed.emulator(t)
		return rows == 30 && cols == 100 && row >= 1
	})
}

// PTY の読み取り（pump）が、画面の状態を持つせいで遅くならないことを測る（KISUI_PUMP_BENCH=1 で動く）。
// yes の出力 32 MiB を読み切るまでの時間を、画面の状態あり・なし（screenFeed を閉じて何も渡さない）で比べる。
func TestPumpSpeedWithScreen(t *testing.T) {
	if os.Getenv("KISUI_PUMP_BENCH") == "" {
		t.Skip("set KISUI_PUMP_BENCH=1 to measure")
	}
	for _, feed := range []string{"off", "on", "off", "on"} {
		srv, sock := start(t)
		c, nt := termClient(t, sock)
		id := createTerm(t, c, nil)
		tm, _ := srv.terms.get(id)
		if feed == "off" {
			tm.feed.close()
		}
		begin := time.Now()
		c.Call(context.Background(), "term.input", map[string]any{"termId": id, "data": b64("yes | head -c 33554432; exit\n")}, nil)
		waitFor(t, "exit", func() bool { return nt.find("term.exit") != nil })
		d := time.Since(begin)
		t.Logf("feed=%-3s read 32 MiB in %v (%.0f MB/s), screen output lost %d bytes", feed, d.Round(time.Millisecond), 33.5/d.Seconds(), tm.feed.lost.Load())
	}
}
