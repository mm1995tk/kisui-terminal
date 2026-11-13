package relay

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// frame は試験の窓が受け取った枠。
type frame struct {
	typ     byte
	payload []byte
}

// client は試験の中の窓。relay を pipe でつなぎ、受け取った枠を接続ごとに振り分ける。
type client struct {
	t    *testing.T
	in   *io.PipeWriter // relay の標準入力
	done chan error     // Run の返り値

	mu      sync.Mutex
	streams map[uint32]chan frame
}

func start(t *testing.T) *client {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	c := &client{t: t, in: inW, done: make(chan error, 1), streams: map[uint32]chan frame{}}
	go func() {
		err := Run(Options{In: inR, Out: outW, DialTimeout: 2 * time.Second})
		outW.Close()
		c.done <- err
	}()
	br := bufio.NewReader(outR)
	line, err := br.ReadString('\n')
	if err != nil || line != Marker {
		t.Fatalf("marker = %q, %v", line, err)
	}
	go func() {
		for {
			typ, id, payload, err := readFrame(br)
			if err != nil {
				return
			}
			c.ch(id) <- frame{typ, payload}
		}
	}()
	t.Cleanup(func() {
		inW.Close()
		select {
		case <-c.done:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after stdin closed")
		}
	})
	return c
}

func (c *client) ch(id uint32) chan frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch, ok := c.streams[id]
	if !ok {
		ch = make(chan frame, 4096)
		c.streams[id] = ch
	}
	return ch
}

func (c *client) send(typ byte, id uint32, payload []byte) {
	c.t.Helper()
	buf := make([]byte, HeaderSize+len(payload))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], id)
	binary.BigEndian.PutUint32(buf[5:9], uint32(len(payload)))
	copy(buf[HeaderSize:], payload)
	if _, err := c.in.Write(buf); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *client) open(id uint32, host string, port int) {
	c.t.Helper()
	p := binary.BigEndian.AppendUint16(nil, uint16(port))
	c.send(FrameOpen, id, append(p, host...))
}

func (c *client) ack(id uint32, n int) {
	c.t.Helper()
	c.send(FrameAck, id, binary.BigEndian.AppendUint32(nil, uint32(n)))
}

// next は接続 id の次の枠。
func (c *client) next(id uint32) frame {
	c.t.Helper()
	select {
	case f := <-c.ch(id):
		return f
	case <-time.After(5 * time.Second):
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		c.t.Fatalf("no frame for connection %d\n%s", id, buf[:n])
		return frame{}
	}
}

func (c *client) expect(id uint32, typ byte) frame {
	c.t.Helper()
	f := c.next(id)
	if f.typ != typ {
		c.t.Fatalf("connection %d: frame %d %q, want type %d", id, f.typ, f.payload, typ)
	}
	return f
}

// readAll は EOF までの DATA を集め、受け取るたびに ack する。
func (c *client) readAll(id uint32) []byte {
	c.t.Helper()
	var b []byte
	for {
		f := c.next(id)
		switch f.typ {
		case FrameData:
			b = append(b, f.payload...)
			c.ack(id, len(f.payload))
		case FrameEOF:
			return b
		default:
			c.t.Fatalf("connection %d: frame %d %q while reading", id, f.typ, f.payload)
		}
	}
}

// listen は addr（"127.0.0.1:0" など）で待ち、来た接続を handle に渡す。
func listen(t *testing.T, addr string, handle func(net.Conn)) int {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("listen %s: %v", addr, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// echoUpper は読んだものを大文字にして返し、相手の EOF で閉じる。
func echoUpper(conn net.Conn) {
	defer conn.Close()
	b, _ := io.ReadAll(conn)
	conn.Write(bytes.ToUpper(b))
}

func TestMarkerHasVersion(t *testing.T) {
	if want := "@@kisui-relay " + string(rune('0'+Version)) + "@@\n"; Marker != want {
		t.Errorf("Marker = %q, want %q", Marker, want)
	}
}

func TestRelay(t *testing.T) {
	port := listen(t, "127.0.0.1:0", echoUpper)
	c := start(t)
	c.open(1, "127.0.0.1", port)
	c.expect(1, FrameOpened)
	c.send(FrameData, 1, []byte("hello"))
	if f := c.expect(1, FrameAck); binary.BigEndian.Uint32(f.payload) != 5 {
		t.Errorf("ack %v, want 5", f.payload)
	}
	c.send(FrameEOF, 1, nil)
	if got := string(c.readAll(1)); got != "HELLO" {
		t.Errorf("got %q", got)
	}
	if f := c.expect(1, FrameClose); len(f.payload) != 0 {
		t.Errorf("close reason %q, want none", f.payload)
	}
}

// つながる前に送った DATA も、つながってから届く。
func TestDataBeforeOpened(t *testing.T) {
	port := listen(t, "127.0.0.1:0", echoUpper)
	c := start(t)
	c.open(1, "localhost", port)
	c.send(FrameData, 1, []byte("early"))
	c.send(FrameEOF, 1, nil)
	c.expect(1, FrameOpened)
	c.expect(1, FrameAck)
	if got := string(c.readAll(1)); got != "EARLY" {
		t.Errorf("got %q", got)
	}
	c.expect(1, FrameClose)
}

func TestManyConnections(t *testing.T) {
	port := listen(t, "127.0.0.1:0", echoUpper)
	c := start(t)
	const n = 20
	for id := uint32(1); id <= n; id++ {
		c.open(id, "127.0.0.1", port)
	}
	for id := uint32(1); id <= n; id++ {
		c.send(FrameData, id, []byte(strings.Repeat(string(rune('a'+id)), int(id))))
		c.send(FrameEOF, id, nil)
	}
	var wg sync.WaitGroup
	for id := uint32(1); id <= n; id++ {
		wg.Go(func() {
			want := strings.Repeat(string(rune('A'+id)), int(id))
			var got []byte
			for {
				f := c.next(id)
				if f.typ == FrameData {
					got = append(got, f.payload...)
					c.ack(id, len(f.payload))
				}
				if f.typ == FrameClose {
					break
				}
			}
			if string(got) != want {
				t.Errorf("connection %d: got %q, want %q", id, got, want)
			}
		})
	}
	wg.Wait()
}

// localhost は ::1 でつながらなければ 127.0.0.1 を試す。IPv4 だけで待つサーバーにつながる。
func TestLocalhostFallsBackToIPv4(t *testing.T) {
	port := listen(t, "127.0.0.1:0", echoUpper)
	c := start(t)
	c.open(1, "localhost", port)
	c.expect(1, FrameOpened)
	c.send(FrameData, 1, []byte("v4"))
	c.send(FrameEOF, 1, nil)
	c.expect(1, FrameAck)
	if got := string(c.readAll(1)); got != "V4" {
		t.Errorf("got %q", got)
	}
}

func TestLocalhostIPv6(t *testing.T) {
	port := listen(t, "[::1]:0", echoUpper)
	c := start(t)
	c.open(1, "localhost", port)
	c.expect(1, FrameOpened)
	c.open(2, "[::1]", port)
	c.expect(2, FrameOpened)
}

func TestDeniedHosts(t *testing.T) {
	port := listen(t, "127.0.0.1:0", echoUpper)
	c := start(t)
	for i, host := range []string{"example.com", "127.0.0.2", "0.0.0.0", "10.0.0.1", "foo.localhost", "localhost.", ""} {
		id := uint32(i + 1)
		c.open(id, host, port)
		if f := c.expect(id, FrameClose); !strings.HasPrefix(string(f.payload), ReasonDenied) {
			t.Errorf("%q: close reason %q, want %s", host, f.payload, ReasonDenied)
		}
	}
	c.open(100, "127.0.0.1", 0)
	if f := c.expect(100, FrameClose); !strings.HasPrefix(string(f.payload), ReasonDenied) {
		t.Errorf("port 0: close reason %q", f.payload)
	}
}

func TestUnreachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	c := start(t)
	c.open(1, "127.0.0.1", port)
	if f := c.expect(1, FrameClose); !strings.HasPrefix(string(f.payload), ReasonUnreachable) {
		t.Errorf("close reason %q", f.payload)
	}
}

// 窓が ack しないと、relay は Window までしか送らない。ack すると続きを送る。
// そのあいだも、ほかの接続は流れる。
func TestFlowControlToWindow(t *testing.T) {
	const total = 4 * Window
	big := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		defer conn.Close()
		conn.Write(bytes.Repeat([]byte("x"), total))
	})
	small := listen(t, "127.0.0.1:0", echoUpper)
	c := start(t)
	c.open(1, "127.0.0.1", big)
	c.expect(1, FrameOpened)
	got := 0
	for got < Window {
		got += len(c.expect(1, FrameData).payload)
	}
	if got != Window {
		t.Fatalf("got %d bytes without an ack, want %d", got, Window)
	}
	select {
	case f := <-c.ch(1):
		t.Fatalf("frame %d (%d bytes) beyond the window", f.typ, len(f.payload))
	case <-time.After(200 * time.Millisecond):
	}

	c.open(2, "127.0.0.1", small)
	c.expect(2, FrameOpened)
	c.send(FrameData, 2, []byte("ok"))
	c.send(FrameEOF, 2, nil)
	c.expect(2, FrameAck)
	if s := string(c.readAll(2)); s != "OK" {
		t.Errorf("other connection: %q", s)
	}

	c.ack(1, got)
	rest := c.readAll(1)
	if got+len(rest) != total {
		t.Errorf("got %d bytes in all, want %d", got+len(rest), total)
	}
}

// fillUntilStalled は、ack の分だけ送る窓として接続 id に送り続け、ack が 300 ミリ秒来なくなったら返す。
// total を送りきっても止まらなければ失敗にする。
func (c *client) fillUntilStalled(id uint32, total int) (sent, acked int) {
	c.t.Helper()
	for sent < total {
		for sent-acked < Window && sent < total {
			n := min(chunk, total-sent, Window-(sent-acked))
			c.send(FrameData, id, make([]byte, n))
			sent += n
		}
		select {
		case f := <-c.ch(id):
			if f.typ != FrameAck {
				c.t.Fatalf("frame %d %q", f.typ, f.payload)
			}
			acked += int(binary.BigEndian.Uint32(f.payload))
		case <-time.After(300 * time.Millisecond):
			return sent, acked
		}
	}
	c.t.Fatalf("the relay acked all %d bytes while nobody read them", total)
	return
}

// stallTotal は、読まない TCP の先に送りきれない量（OS のソケットのバッファより十分大きい）。
const stallTotal = 64 << 20

// 窓→TCP の向き: TCP の先が読まなければ ack が止まる。読めば、書けた分の ack が来る。
func TestFlowControlFromWindow(t *testing.T) {
	release := make(chan struct{})
	received := make(chan int, 1)
	port := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		defer conn.Close()
		<-release
		n, _ := io.Copy(io.Discard, conn)
		received <- int(n)
	})
	c := start(t)
	c.open(1, "127.0.0.1", port)
	c.expect(1, FrameOpened)
	sent, acked := c.fillUntilStalled(1, stallTotal)
	close(release)
	for acked < sent {
		acked += int(binary.BigEndian.Uint32(c.expect(1, FrameAck).payload))
	}
	c.send(FrameEOF, 1, nil)
	select {
	case n := <-received:
		if n != sent {
			t.Errorf("server received %d, want %d", n, sent)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the server did not see the end")
	}
}

// ack を待たずに Window を超えて送る窓は、その接続を閉じられる。
func TestWindowExceeded(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	port := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		defer conn.Close()
		<-release
	})
	c := start(t)
	c.open(1, "127.0.0.1", port)
	c.expect(1, FrameOpened)
	sent, acked := c.fillUntilStalled(1, stallTotal)
	for over := Window - (sent - acked) + 1; over > 0; over -= chunk {
		c.send(FrameData, 1, make([]byte, min(over, chunk)))
	}
	for {
		f := c.next(1)
		if f.typ == FrameClose {
			if !strings.HasPrefix(string(f.payload), ReasonProtocol) {
				t.Errorf("close reason %q", f.payload)
			}
			return
		}
	}
}

// TCP の先が切れたら、窓に EOF と CLOSE が届く。窓の CLOSE で TCP が閉じる。
func TestConnectionEnds(t *testing.T) {
	closed := make(chan struct{})
	port := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		conn.Write([]byte("bye"))
		conn.Close()
	})
	hold := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		io.Copy(io.Discard, conn)
		close(closed)
	})
	c := start(t)
	c.open(1, "127.0.0.1", port)
	c.expect(1, FrameOpened)
	if got := string(c.readAll(1)); got != "bye" {
		t.Errorf("got %q", got)
	}
	c.send(FrameEOF, 1, nil)
	c.expect(1, FrameClose)

	c.open(2, "127.0.0.1", hold)
	c.expect(2, FrameOpened)
	c.send(FrameClose, 2, nil)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the TCP connection stayed open after CLOSE")
	}
}

// 標準入力が終わったら（ssh が切れたら）、開いている接続を閉じて Run が返る。
func TestStdinEndsClosesAll(t *testing.T) {
	closed := make(chan struct{})
	port := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		io.Copy(io.Discard, conn)
		close(closed)
	})
	c := start(t)
	c.open(1, "127.0.0.1", port)
	c.expect(1, FrameOpened)
	c.in.Close()
	select {
	case err := <-c.done:
		if err != nil {
			t.Errorf("Run: %v", err)
		}
		c.done <- nil
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the TCP connection stayed open")
	}
}

func TestLimit(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	port := listen(t, "127.0.0.1:0", func(conn net.Conn) {
		defer conn.Close()
		<-release
	})
	c := start(t)
	for id := uint32(1); id <= MaxStreams; id++ {
		c.open(id, "127.0.0.1", port)
	}
	c.open(MaxStreams+1, "127.0.0.1", port)
	if f := c.expect(MaxStreams+1, FrameClose); !strings.HasPrefix(string(f.payload), ReasonLimit) {
		t.Errorf("close reason %q", f.payload)
	}
	// 1 本閉じれば、また開ける。
	c.send(FrameClose, 1, nil)
	time.Sleep(50 * time.Millisecond)
	c.open(MaxStreams+2, "127.0.0.1", port)
	c.expect(MaxStreams+2, FrameOpened)
}

func TestProtocolErrors(t *testing.T) {
	for name, input := range map[string][]byte{
		"unknown type":  {99, 0, 0, 0, 1, 0, 0, 0, 0},
		"too long":      {FrameData, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff},
		"cut":           {FrameData, 0, 0, 0, 1, 0, 0, 0, 5, 'a'},
		"id decreasing": append([]byte{FrameOpen, 0, 0, 0, 2, 0, 0, 0, 3, 0, 1, 'x'}, FrameOpen, 0, 0, 0, 1, 0, 0, 0, 3, 0, 1, 'x'),
	} {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			err := Run(Options{In: bytes.NewReader(input), Out: &out})
			if _, ok := errors.AsType[*ProtocolError](err); !ok {
				t.Errorf("err = %v, want a ProtocolError", err)
			}
		})
	}
}
