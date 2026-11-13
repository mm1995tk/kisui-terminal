// Package relay は「kisui relay」の中身。ssh の先（リモートのマシン）で動き、標準入出力の上の
// 枠（フレーム）で、そのマシンの loopback のポートへの TCP 接続を何本でも中継する。
// 窓（Rust の側）が `ssh <マシン> -- <kisui> relay` で起こし、手元のブラウザの接続を運ぶ。
// ssh のポート転送（-L）が使えない環境でも、ターミナルが使えれば URL を開けるようにするため。
// 取り決めは docs/design/relay.md。
package relay

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

// Marker は始まりの目印。ログインシェルが motd などを標準出力に出しても、窓はこの行より前を捨てる。
// 数字は取り決めの版（Version）。枠の形や意味を変えて、前の版の窓と話せなくなったら上げる。
const Marker = "@@kisui-relay " + versionText + "@@\n"

// Version は取り決めの版。
const Version = 1

const versionText = "1"

// 枠の種類（枠の先頭の 1 バイト）。
const (
	FrameOpen   byte = 1 // 窓→relay。中身はポート（2 バイト）と host。
	FrameOpened byte = 2 // relay→窓。つながった。中身なし。
	FrameData   byte = 3 // 両向き。中身はバイト列。
	FrameAck    byte = 4 // 両向き。中身は書き終えたバイト数（4 バイト）。
	FrameEOF    byte = 5 // 両向き。もう送らない（TCP の半分の閉じ）。中身なし。
	FrameClose  byte = 6 // 両向き。接続を捨てる。中身は理由（空なら正常の終わり）。
)

const (
	// HeaderSize は枠の頭の大きさ: 種類（1）・接続の番号（4）・中身の長さ（4）。
	HeaderSize = 9
	// MaxPayload は 1 つの枠の中身の最大。これより長い枠は取り決めの違反。
	MaxPayload = 64 << 10
	// Window は、1 本の接続の 1 つの向きで、相手が ack していないまま送ってよいバイト数。
	Window = 256 << 10
	// MaxStreams は同時に開いておける接続の数。
	MaxStreams = 256
	// chunk は TCP から 1 回に読んで 1 つの DATA の枠にする最大。
	chunk = 32 << 10
)

// CLOSE の理由。窓はこれで、ブラウザにどう見せるかを決められる。後ろに ": 詳しいこと" が付くことがある。
const (
	ReasonDenied      = "denied"      // loopback 以外の host
	ReasonLimit       = "limit"       // 接続の数が MaxStreams を超えた
	ReasonUnreachable = "unreachable" // つなげなかった（そのポートで誰も待っていない など）
	ReasonError       = "error"       // つないだあとの読み書きの失敗
	ReasonProtocol    = "protocol"    // この接続について取り決めに反する枠が来た
)

// Options は Run に渡すもの。
type Options struct {
	In  io.Reader
	Out io.Writer
	// DialTimeout は 1 つの接続をつなぐのを待つ最長時間。0 なら 10 秒。
	DialTimeout time.Duration
}

// ProtocolError は、中継を続けられない取り決めの違反（壊れた枠など）。Run はこれを返して終わる。
type ProtocolError struct{ Msg string }

func (e *ProtocolError) Error() string { return "kisui relay: protocol: " + e.Msg }

// Run は目印を出し、In が終わるまで枠を読んで中継する。In が終わったら（ssh が切れたら）
// 開いている接続をすべて閉じて nil を返す。
func Run(o Options) error {
	if o.DialTimeout == 0 {
		o.DialTimeout = 10 * time.Second
	}
	r := &relay{opts: o, out: o.Out, streams: map[uint32]*stream{}}
	if _, err := io.WriteString(o.Out, Marker); err != nil {
		return err
	}
	err := r.readLoop(bufio.NewReaderSize(o.In, 64<<10))
	r.closeAll()
	r.wg.Wait()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

type relay struct {
	opts Options

	outMu  sync.Mutex
	out    io.Writer
	outErr error

	mu      sync.Mutex
	streams map[uint32]*stream
	lastID  uint32 // 最後に開いた接続の番号。番号は増える一方で、使い回さない。
	opened  bool

	wg sync.WaitGroup
}

// send は枠を 1 つ書く。標準出力が壊れたら（ssh が切れたら）以後は何も書かない。In も
// やがて終わり、Run が返る。
func (r *relay) send(typ byte, id uint32, payload []byte) {
	buf := make([]byte, HeaderSize+len(payload))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], id)
	binary.BigEndian.PutUint32(buf[5:9], uint32(len(payload)))
	copy(buf[HeaderSize:], payload)
	r.outMu.Lock()
	defer r.outMu.Unlock()
	if r.outErr != nil {
		return
	}
	_, r.outErr = r.out.Write(buf)
}

func (r *relay) sendAck(id uint32, n int) {
	var p [4]byte
	binary.BigEndian.PutUint32(p[:], uint32(n))
	r.send(FrameAck, id, p[:])
}

// readFrame は枠を 1 つ読む。In が枠の切れ目で終わったら io.EOF を返す。
func readFrame(br *bufio.Reader) (typ byte, id uint32, payload []byte, err error) {
	var h [HeaderSize]byte
	if _, err = io.ReadFull(br, h[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			err = &ProtocolError{"input ended in the middle of a frame"}
		}
		return
	}
	typ = h[0]
	id = binary.BigEndian.Uint32(h[1:5])
	n := binary.BigEndian.Uint32(h[5:9])
	if n > MaxPayload {
		err = &ProtocolError{fmt.Sprintf("frame of %d bytes (the limit is %d)", n, MaxPayload)}
		return
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(br, payload); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			err = &ProtocolError{"input ended in the middle of a frame"}
		}
	}
	return
}

func (r *relay) readLoop(br *bufio.Reader) error {
	for {
		typ, id, payload, err := readFrame(br)
		if err != nil {
			return err
		}
		switch typ {
		case FrameOpen:
			if err := r.open(id, payload); err != nil {
				return err
			}
		case FrameData:
			if s := r.stream(id); s != nil {
				s.data(payload)
			}
		case FrameAck:
			if len(payload) != 4 {
				return &ProtocolError{"ack of " + strconv.Itoa(len(payload)) + " bytes"}
			}
			if s := r.stream(id); s != nil {
				s.ack(int(binary.BigEndian.Uint32(payload)))
			}
		case FrameEOF:
			if s := r.stream(id); s != nil {
				s.eof()
			}
		case FrameClose:
			if s := r.stream(id); s != nil {
				s.finish("", false)
			}
		default:
			return &ProtocolError{fmt.Sprintf("unknown frame type %d", typ)}
		}
	}
}

// stream は開いている接続。閉じた接続の番号への枠は捨てる（行き違いはありうる）。
func (r *relay) stream(id uint32) *stream {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.streams[id]
}

func (r *relay) remove(id uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.streams, id)
}

// open は OPEN の枠を受ける。番号が増えていないのは窓の誤りで、続けると別の接続の枠と
// 取り違えるので、中継ごと止める。
func (r *relay) open(id uint32, payload []byte) error {
	r.mu.Lock()
	if r.opened && id <= r.lastID {
		r.mu.Unlock()
		return &ProtocolError{fmt.Sprintf("open of connection %d after %d (the numbers must increase)", id, r.lastID)}
	}
	r.opened, r.lastID = true, id
	if len(payload) < 2 {
		r.mu.Unlock()
		r.send(FrameClose, id, []byte(ReasonProtocol+": open without a port"))
		return nil
	}
	port := binary.BigEndian.Uint16(payload[:2])
	host := string(payload[2:])
	addrs, ok := loopbackAddrs(host)
	if !ok || port == 0 {
		r.mu.Unlock()
		r.send(FrameClose, id, []byte(ReasonDenied+": "+strconv.Quote(host)+" is not this machine's loopback"))
		return nil
	}
	if len(r.streams) >= MaxStreams {
		r.mu.Unlock()
		r.send(FrameClose, id, fmt.Appendf(nil, "%s: %d connections are open", ReasonLimit, MaxStreams))
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.opts.DialTimeout)
	s := &stream{id: id, r: r, credit: Window, cancel: cancel}
	s.cond = sync.NewCond(&s.mu)
	r.streams[id] = s
	r.mu.Unlock()

	r.wg.Go(func() {
		s.run(ctx, addrs, port)
	})
	return nil
}

func (r *relay) closeAll() {
	r.mu.Lock()
	all := make([]*stream, 0, len(r.streams))
	for _, s := range r.streams {
		all = append(all, s)
	}
	r.mu.Unlock()
	for _, s := range all {
		s.finish("", false)
	}
}

// loopbackAddrs は host がこのマシンの loopback ならその IP を、試す順に返す。
// 受けるのは localhost・127.0.0.1・::1（[::1] も）だけ。ssh -L 127.0.0.1:<手元>:localhost:<ポート> と
// 同じ範囲で、ほかのホストへは中継しない。localhost は名前解決に頼らず ::1・127.0.0.1 の順に試す
// （/etc/hosts の書き換えで loopback の外へ向かないように。IPv4 だけで待つサーバーにもつながる）。
func loopbackAddrs(host string) ([]string, bool) {
	switch host {
	case "localhost":
		return []string{"::1", "127.0.0.1"}, true
	case "127.0.0.1":
		return []string{"127.0.0.1"}, true
	case "::1", "[::1]":
		return []string{"::1"}, true
	}
	return nil, false
}

// stream は中継している 1 本の TCP 接続。
//
// 流量の制御: 窓→TCP の向きは、窓が ack を待たずに送れるのが Window までなので、queue に溜まるのも
// Window まで（超えたら取り決めの違反として閉じる）。TCP に書けた分だけ ack を返すので、TCP の先が
// 読まなければ窓が送るのを止める。TCP→窓の向きは、credit（窓が ack していない残り）が 0 なら TCP を
// 読まない。どちらも 1 本の接続の中で止まり、ほかの接続と標準入力の読みは止めない。
type stream struct {
	id     uint32
	r      *relay
	cancel context.CancelFunc

	mu      sync.Mutex
	cond    *sync.Cond
	conn    net.Conn // つながるまでは nil
	queue   [][]byte // 窓から来て、まだ TCP に書いていないもの
	queued  int      // queue のバイト数
	inEOF   bool     // 窓が EOF を送った
	credit  int      // 窓へまだ送ってよいバイト数
	readEnd bool     // TCP→窓の向きが終わった（EOF を送った）
	wrEnd   bool     // 窓→TCP の向きが終わった（CloseWrite した）
	closed  bool
}

// run はつないで OPENED を返し、両向きのコピーを動かす。
func (s *stream) run(ctx context.Context, addrs []string, port uint16) {
	conn, err := dial(ctx, addrs, port)
	s.cancel()
	if err != nil {
		s.finish(ReasonUnreachable+": "+err.Error(), true)
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		conn.Close()
		return
	}
	s.conn = conn
	s.mu.Unlock()
	s.r.send(FrameOpened, s.id, nil)
	s.r.wg.Go(func() {
		s.readTCP(conn)
	})
	s.writeTCP(conn)
}

func dial(ctx context.Context, addrs []string, port uint16) (net.Conn, error) {
	var d net.Dialer
	var err error
	for _, a := range addrs {
		var c net.Conn
		c, err = d.DialContext(ctx, "tcp", net.JoinHostPort(a, strconv.Itoa(int(port))))
		if err == nil {
			return c, nil
		}
	}
	return nil, err
}

// readTCP は TCP から読んで DATA にする。credit が尽きたら窓の ack を待つ。
func (s *stream) readTCP(conn net.Conn) {
	buf := make([]byte, chunk)
	for {
		s.mu.Lock()
		for s.credit == 0 && !s.closed {
			s.cond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		n := min(s.credit, chunk)
		s.mu.Unlock()

		got, err := conn.Read(buf[:n])
		if got > 0 {
			s.mu.Lock()
			s.credit -= got
			closed := s.closed
			s.mu.Unlock()
			if closed {
				return
			}
			s.r.send(FrameData, s.id, buf[:got])
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				s.r.send(FrameEOF, s.id, nil)
				s.mu.Lock()
				s.readEnd = true
				s.mu.Unlock()
				s.maybeDone()
				return
			}
			s.finish(ReasonError+": "+err.Error(), true)
			return
		}
	}
}

// writeTCP は窓から来たものを TCP に書き、書けた分を ack する。窓の EOF で書く向きを閉じる。
func (s *stream) writeTCP(conn net.Conn) {
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.inEOF && !s.closed {
			s.cond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		if len(s.queue) == 0 { // inEOF
			s.wrEnd = true
			s.mu.Unlock()
			if cw, ok := conn.(interface{ CloseWrite() error }); ok {
				cw.CloseWrite()
			}
			s.maybeDone()
			return
		}
		b := s.queue[0]
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.mu.Unlock()

		if _, err := conn.Write(b); err != nil {
			s.finish(ReasonError+": "+err.Error(), true)
			return
		}
		s.mu.Lock()
		s.queued -= len(b)
		closed := s.closed
		s.mu.Unlock()
		if closed {
			return
		}
		s.r.sendAck(s.id, len(b))
	}
}

// data は窓からの DATA。つながる前に来てもよい（つながったら書く）。
func (s *stream) data(b []byte) {
	if len(b) == 0 {
		return
	}
	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		return
	case s.inEOF:
		s.mu.Unlock()
		s.finish(ReasonProtocol+": data after eof", true)
		return
	case s.queued+len(b) > Window:
		s.mu.Unlock()
		s.finish(fmt.Sprintf("%s: more than %d bytes without an ack", ReasonProtocol, Window), true)
		return
	}
	s.queue = append(s.queue, b)
	s.queued += len(b)
	s.cond.Broadcast()
	s.mu.Unlock()
}

// ack は窓からの ACK。窓が受け取って書き終えた分だけ、また送ってよい。
func (s *stream) ack(n int) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if n < 0 || s.credit+n > Window {
		s.mu.Unlock()
		s.finish(ReasonProtocol+": ack of more than was sent", true)
		return
	}
	s.credit += n
	s.cond.Broadcast()
	s.mu.Unlock()
}

func (s *stream) eof() {
	s.mu.Lock()
	s.inEOF = true
	s.cond.Broadcast()
	s.mu.Unlock()
}

// maybeDone は両向きが終わったら接続を閉じ、CLOSE（理由は空）を送る。
func (s *stream) maybeDone() {
	s.mu.Lock()
	done := s.readEnd && s.wrEnd
	s.mu.Unlock()
	if done {
		s.finish("", true)
	}
}

// finish は接続を捨てる。notify なら窓に CLOSE を送る（窓が CLOSE を送ってきたときは返さない）。
// 2 度目からは何もしない。
func (s *stream) finish(reason string, notify bool) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	conn := s.conn
	s.queue, s.queued = nil, 0
	s.cond.Broadcast()
	s.mu.Unlock()
	s.cancel()
	if conn != nil {
		conn.Close()
	}
	s.r.remove(s.id)
	if notify {
		s.r.send(FrameClose, s.id, []byte(reason))
	}
}
