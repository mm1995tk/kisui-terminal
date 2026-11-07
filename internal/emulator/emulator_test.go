package emulator

import (
	"bytes"
	"sync"
	"testing"
)

func TestWriteMovesCursorAndResizes(t *testing.T) {
	e, err := New(24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if r, c, _ := e.Size(); r != 24 || c != 80 {
		t.Fatalf("size = %dx%d", r, c)
	}
	if _, err := e.Write([]byte("ab\r\ncd")); err != nil {
		t.Fatal(err)
	}
	if r, c, _ := e.Cursor(); r != 1 || c != 2 {
		t.Errorf("cursor = %d,%d, want 1,2", r, c)
	}
	if err := e.Resize(30, 100); err != nil {
		t.Fatal(err)
	}
	if r, c, _ := e.Size(); r != 30 || c != 100 {
		t.Errorf("size after resize = %dx%d", r, c)
	}
}

// 問い合わせ（DA1・DECRQM）には返事を作る。それを Write が捨てる（捨てた数が戻る）ことで、
// 返事がどこにも出ないことを確かめる。
func TestRepliesAreDropped(t *testing.T) {
	e, err := New(24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, q := range []string{"\x1b[c", "\x1b[?2026$p", "\x1b[>c", "\x1b[?u"} {
		n, err := e.Write([]byte(q))
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Errorf("%q: the emulator made no reply, so this does not test the drop", q)
		}
	}
	// 返事は溜まらない（次の書き込みで捨てた数が増えない）
	if n, _ := e.Write([]byte("x")); n != 0 {
		t.Errorf("a reply was kept across writes: %d", n)
	}
}

func TestLargeWriteIsChunked(t *testing.T) {
	e, err := New(24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	big := bytes.Repeat([]byte("a\r\n"), chunk) // chunk を超える
	if _, err := e.Write(big); err != nil {
		t.Fatal(err)
	}
	if r, _, _ := e.Cursor(); r != 23 {
		t.Errorf("cursor row = %d, want 23", r)
	}
}

func TestInstancesAreIndependentAndClose(t *testing.T) {
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			e, err := New(10, 10)
			if err != nil {
				t.Error(err)
				return
			}
			e.Write([]byte("hi"))
			e.Close()
			e.Close()
			if _, err := e.Write([]byte("x")); err == nil {
				t.Error("write after close succeeded")
			}
		})
	}
	wg.Wait()
}

func BenchmarkWrite(b *testing.B) {
	e, err := New(24, 80)
	if err != nil {
		b.Fatal(err)
	}
	defer e.Close()
	data := bytes.Repeat([]byte("y\n"), 16<<10) // 32 KiB
	b.SetBytes(int64(len(data)))
	for b.Loop() {
		e.Write(data)
	}
}
