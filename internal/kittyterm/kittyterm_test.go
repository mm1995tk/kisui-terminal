package kittyterm

import (
	"bytes"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

func enc(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestNotification(t *testing.T) {
	got := string(Notification("done; \x1b]x"))
	if want := "\x1b]99;e=1;" + enc("done; \x1b]x") + "\x1b\\"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// A write is "write", the data in chunks of base64 that each decode alone,
// and the empty "wdata" that ends it.
func TestClipboardWrite(t *testing.T) {
	data := bytes.Repeat([]byte("あいう"), 2000) // 18000 bytes: 6 chunks
	var sc Scanner
	ps := sc.Feed(ClipboardWrite("kisui-1", data))
	if len(ps) != 8 {
		t.Fatalf("%d packets", len(ps))
	}
	if ps[0].Meta["type"] != "write" || ps[0].Meta["id"] != "kisui-1" {
		t.Errorf("first: %+v", ps[0])
	}
	var got []byte
	for _, p := range ps[1:7] {
		if p.Meta["type"] != "wdata" || p.Meta["mime"] != enc("text/plain") || len(p.Payload) > 4096 {
			t.Errorf("data: %+v", p.Meta)
		}
		b, err := base64.StdEncoding.DecodeString(p.Payload)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, b...)
	}
	if !bytes.Equal(got, data) {
		t.Error("the data differs")
	}
	if last := ps[7]; last.Meta["type"] != "wdata" || last.Meta["mime"] != "" || last.Payload != "" {
		t.Errorf("last: %+v", last)
	}
	// Empty text is one data packet with no payload.
	if ps := sc.Feed(ClipboardWrite("x", nil)); len(ps) != 3 || ps[1].Meta["mime"] != enc("text/plain") || ps[1].Payload != "" {
		t.Errorf("empty: %+v", ps)
	}
}

func TestClipboardRead(t *testing.T) {
	var sc Scanner
	ps := sc.Feed(ClipboardRead("kisui-2"))
	if len(ps) != 1 || ps[0].Meta["type"] != "read" || ps[0].Meta["id"] != "kisui-2" || ps[0].Payload != enc("text/plain") {
		t.Errorf("%+v", ps)
	}
}

// The scanner takes OSC 5522 ended by ST or BEL, in pieces, and drops the
// rest: keys, other OSCs, a broken-off OSC.
func TestScanner(t *testing.T) {
	in := "ab\x1b[A\x1b]99;x\x1b\\\x1b]5522;type=read:status=OK:id=a\x07c\x1b]5522;broken\x1b]5522;type=read:status=DONE:id=a\x1b\\"
	var sc Scanner
	var ps []Packet
	for i := range len(in) {
		ps = append(ps, sc.Feed([]byte{in[i]})...)
	}
	if len(ps) != 2 || ps[0].Meta["status"] != "OK" || ps[1].Meta["status"] != "DONE" {
		t.Errorf("%+v", ps)
	}
}

func TestWriteReply(t *testing.T) {
	h := WriteReply("a")
	if done, _ := h(parsePacket("type=write:status=DONE:id=b")); done {
		t.Error("took the answer to another id")
	}
	if done, err := h(parsePacket("type=write:status=DONE:id=a")); !done || err != nil {
		t.Errorf("DONE: %v %v", done, err)
	}
	var se *StatusError
	if done, err := h(parsePacket("type=write:status=EIO:id=a")); !done || !errors.As(err, &se) || se.Status != "EIO" {
		t.Errorf("EIO: %v %v", done, err)
	}
}

func TestTextReply(t *testing.T) {
	r := &TextReply{ID: "a"}
	for _, p := range []string{
		"type=read:status=OK:id=a",
		"type=read:status=DATA:id=b:mime=" + enc("text/plain") + ";" + enc("other"),
		"type=read:status=DATA:id=a:mime=" + enc("image/png") + ";" + enc("png"),
		"type=read:status=DATA:id=a:mime=" + enc("text/plain") + ";" + enc("hel"),
		"type=read:status=DATA:id=a:mime=" + enc("text/plain") + ";" + enc("lo"),
	} {
		if done, err := r.Handle(parsePacket(p)); done || err != nil {
			t.Fatalf("%s: %v %v", p, done, err)
		}
	}
	if done, err := r.Handle(parsePacket("type=read:status=DONE:id=a")); !done || err != nil || string(r.Text) != "hello" {
		t.Errorf("DONE: %v %v %q", done, err, r.Text)
	}
	var se *StatusError
	r = &TextReply{ID: "a"}
	if done, err := r.Handle(parsePacket("type=read:status=EPERM:id=a")); !done || !errors.As(err, &se) || se.Status != "EPERM" {
		t.Errorf("EPERM: %v %v", done, err)
	}
}

// Ask writes the request to the terminal, reads the answer in between other
// bytes, and puts the terminal back (echo and lines) when it returns.
func TestAskOnAPTY(t *testing.T) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Skip("no pty:", err)
	}
	defer ptmx.Close()
	defer tty.Close()
	tt := &TTY{fd: int(tty.Fd())}

	// The terminal: it answers the reads, except the one with the id "x".
	type req struct{ id, payload string }
	reqs := make(chan req, 4)
	go func() {
		var sc Scanner
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				return
			}
			for _, p := range sc.Feed(buf[:n]) {
				if p.Meta["type"] != "read" {
					continue
				}
				id := p.Meta["id"]
				reqs <- req{id, p.Payload}
				if id == "x" {
					continue
				}
				_, _ = ptmx.Write([]byte("typed\x1b]5522;type=read:status=OK:id=" + id + "\x1b\\" +
					"\x1b]5522;type=read:status=DATA:id=" + id + ":mime=" + enc("text/plain") + ";" + enc("hello") + "\x1b\\" +
					"\x1b]5522;type=read:status=DONE:id=" + id + "\x1b\\"))
			}
		}
	}()
	r := &TextReply{ID: NewID()}
	if err := tt.Ask(ClipboardRead(r.ID), 5*time.Second, r.Handle); err != nil {
		t.Fatal(err)
	}
	if q := <-reqs; q.id != r.ID || q.payload != enc("text/plain") {
		t.Errorf("request %+v", q)
	}
	if string(r.Text) != "hello" {
		t.Errorf("text %q", r.Text)
	}
	if tio, err := unix.IoctlGetTermios(tt.fd, ioctlGetTermios); err != nil || tio.Lflag&(unix.ECHO|unix.ICANON) != unix.ECHO|unix.ICANON {
		t.Errorf("the terminal was not put back: %v", err)
	}

	// No answer: it gives up at the time out.
	start := time.Now()
	if err := tt.Ask(ClipboardRead("x"), 300*time.Millisecond, (&TextReply{ID: "x"}).Handle); !errors.Is(err, ErrTimeout) {
		t.Errorf("no answer: %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("waited %v", d)
	}
	select {
	case q := <-reqs:
		if q.id != "x" {
			t.Errorf("second request %+v", q)
		}
	case <-time.After(2 * time.Second):
		t.Error("the second request was not written")
	}
}

// InUse is false while the terminal waits for lines (a shell runs the
// command) and true while a full-screen program reads the keys one by one.
func TestInUseOnAPTY(t *testing.T) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Skip("no pty:", err)
	}
	defer ptmx.Close()
	defer tty.Close()
	tt := &TTY{fd: int(tty.Fd())}

	if inUse, err := tt.InUse(); err != nil || inUse {
		t.Errorf("lines: %v %v", inUse, err)
	}
	tio, err := unix.IoctlGetTermios(tt.fd, ioctlGetTermios)
	if err != nil {
		t.Fatal(err)
	}
	tio.Lflag &^= unix.ICANON | unix.ECHO
	if err := unix.IoctlSetTermios(tt.fd, ioctlSetTermios, tio); err != nil {
		t.Fatal(err)
	}
	if inUse, err := tt.InUse(); err != nil || !inUse {
		t.Errorf("keys: %v %v", inUse, err)
	}
}
