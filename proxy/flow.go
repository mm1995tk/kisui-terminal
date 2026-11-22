package proxy

// プロキシを通った通信の記録（#409）。1 往復（要求と応答）を Flow として、新しいものから決まった数だけ覚える。

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"maps"
	"mime"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// MaxFlows は 1 つの記録に覚える通信の数。超えたら古いものから捨てる。
	MaxFlows = 1000
	// MaxBody は要求・応答の本文 1 つにつき覚える大きさ。超えた分は捨て、切れた印を付ける（通信そのものは切らない）。
	MaxBody = 256 << 10
	// MaxStoreBytes は 1 つの記録が覚える本文の合計。超えたら古い通信から捨てる。
	MaxStoreBytes = 64 << 20
	// maxDecoded は、圧縮された本文を見せるために展開する大きさの上限。
	maxDecoded = 1 << 20
)

// 通信の状態。
const (
	StatePending = "pending" // 応答を待っている・本文を受けている
	StateHeld    = "held"    // 行き先に送る前に止めている（#411。Proxy.Release で流す・捨てる）
	StateDone    = "done"
	StateFailed  = "failed" // 行き先につながらない・証明書が正しくない・途中で切れた
)

// Body は覚えた本文。Size は通った大きさ（圧縮されていれば圧縮されたままの大きさ）。
type Body struct {
	Data      []byte
	Size      int64
	Truncated bool
}

// flow は通信 1 つ。Store の mu で守る。
type flow struct {
	id         int64
	start      time.Time
	method     string
	scheme     string
	host       string
	path       string // パスとクエリ
	proto      string // 要求の HTTP の版
	status     int
	state      string
	err        string
	duration   time.Duration
	reqHeader  http.Header
	respHeader http.Header
	reqBody    Body
	respBody   Body
	// resentFrom は、パネルで書き換えて送り直した通信（Resend。#410）のとき、元の通信の id。ほかは 0
	resentFrom int64
	// dial は、Host と違う所につないだときの、つないだ先（host:port。CONNECT で頼まれた行き先。curl --connect-to など）。ほかは ""
	dial string
	// edited は、止めて書き換えてから流した通信（#411）。記録は、書き換えたあとの要求
	edited bool
	// bodyUnread は、止めている要求の本文を読んでいない（大きさが分からない・大きい。#411）
	bodyUnread bool
}

// Summary は一覧の 1 行（JSON は窓との取り決め。docs/design/gui-protocol.md の「プロキシ」）。
type Summary struct {
	ID         int64  `json:"id"`
	Time       int64  `json:"time"` // 始まった時刻（Unix のミリ秒）
	Method     string `json:"method"`
	Scheme     string `json:"scheme"`
	Host       string `json:"host"`
	Path       string `json:"path"`
	Status     int    `json:"status"` // 応答がまだ・無いときは 0
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
	ReqSize    int64  `json:"reqSize"`
	RespSize   int64  `json:"respSize"`
	DurationMs int64  `json:"durationMs"`
	MIME       string `json:"mime,omitempty"` // 応答の Content-Type の種類（text/html など）
	// ResentFrom は、送り直した通信（Resend。#410）のとき、元の通信の id。クライアントから来た通信は 0
	ResentFrom int64 `json:"resentFrom,omitempty"`
	// Edited は、止めて書き換えてから流した通信（#411）
	Edited bool `json:"edited,omitempty"`
}

// BodyView は本文の見せ方。字として読めれば Text、読めなければ Binary。
type BodyView struct {
	Size      int64   `json:"size"`
	Truncated bool    `json:"truncated,omitempty"`
	Text      *string `json:"text,omitempty"`
	Binary    bool    `json:"binary,omitempty"`
	// Encoding は展開できなかった圧縮の種類（Content-Encoding）。
	Encoding string `json:"encoding,omitempty"`
}

// Detail は通信 1 つの中身。ヘッダーは名前の順。
type Detail struct {
	Summary
	Protocol string `json:"protocol"`
	// ConnectTo は、Host と違う所につないだ通信の、つないだ先（host:port）。送り直すとき、同じ所につなぐため（#410）
	ConnectTo string `json:"connectTo,omitempty"`
	// ReqBodyUnread は、止めている（StateHeld）要求の本文を、読んでいない（大きさが分からない・記録の上限より大きい。#411）。
	// ReqBody は空で、流すと、本文はそのまま行き先に送られる
	ReqBodyUnread bool        `json:"reqBodyUnread,omitempty"`
	ReqHeaders    [][2]string `json:"reqHeaders"`
	RespHeaders   [][2]string `json:"respHeaders"`
	ReqBody       BodyView    `json:"reqBody"`
	RespBody      BodyView    `json:"respBody"`
}

// Store は通信の記録。
type Store struct {
	mu    sync.Mutex
	flows []*flow // 古い順
	next  int64
	bytes int64
	// onChange は通信が始まった・変わったときに呼ぶ（mu の外）。
	onChange func(Summary)
}

// NewStore は空の記録を作る。onChange は nil でよい。
func NewStore(onChange func(Summary)) *Store {
	return &Store{onChange: onChange}
}

// Summaries は覚えている通信の一覧（古い順）。
func (s *Store) Summaries() []Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Summary, 0, len(s.flows))
	for _, f := range s.flows {
		out = append(out, f.summary())
	}
	return out
}

// Detail は id の通信の中身。もう覚えていなければ false。
func (s *Store) Detail(id int64) (Detail, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.flows {
		if f.id == id {
			return Detail{
				Summary:       f.summary(),
				Protocol:      f.proto,
				ConnectTo:     f.dial,
				ReqBodyUnread: f.state == StateHeld && f.bodyUnread,
				ReqHeaders:    headerList(f.reqHeader),
				RespHeaders:   headerList(f.respHeader),
				ReqBody:       viewBody(f.reqBody, f.reqHeader),
				RespBody:      viewBody(f.respBody, f.respHeader),
			}, true
		}
	}
	return Detail{}, false
}

func (f *flow) summary() Summary {
	sum := Summary{
		ID: f.id, Time: f.start.UnixMilli(), Method: f.method, Scheme: f.scheme, Host: f.host, Path: f.path,
		Status: f.status, State: f.state, Error: f.err,
		ReqSize: f.reqBody.Size, RespSize: f.respBody.Size, DurationMs: f.duration.Milliseconds(),
		ResentFrom: f.resentFrom, Edited: f.edited,
	}
	if ct := f.respHeader.Get("Content-Type"); ct != "" {
		if mt, _, err := mime.ParseMediaType(ct); err == nil {
			sum.MIME = mt
		}
	}
	return sum
}

// requestBody は id の通信の要求の本文の写し（送り直すときに、元のまま送る本文。#410）。もう覚えていなければ false。
func (s *Store) requestBody(id int64) (Body, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.flows {
		if f.id == id {
			b := f.reqBody
			b.Data = slices.Clone(b.Data)
			return b, true
		}
	}
	return Body{}, false
}

// begin は始まった通信を足す。
// dial は、host と違う所につなぐときの、つなぐ先（"" なら host）。
func (s *Store) begin(r *http.Request, scheme, host, dial string) *flow {
	return s.beginFrom(r, scheme, host, dial, 0)
}

// beginFrom は始まった通信を足す。resentFrom は、送り直した通信のとき、元の通信の id（クライアントから来たものは 0）。
func (s *Store) beginFrom(r *http.Request, scheme, host, dial string, resentFrom int64) *flow {
	return s.beginWith(r, scheme, host, dial, func(f *flow) { f.resentFrom = resentFrom })
}

// beginWith は始まった通信を足す。init は、id を決めたあと・一覧に足す前に、通信を整える（mu を持って呼ぶ）。
func (s *Store) beginWith(r *http.Request, scheme, host, dial string, init func(f *flow)) *flow {
	header := r.Header.Clone()
	if header == nil {
		header = http.Header{}
	}
	if r.Host != "" && header.Get("Host") == "" {
		header.Set("Host", r.Host)
	}
	f := &flow{
		start: time.Now(), method: r.Method, scheme: scheme, host: host, path: r.URL.RequestURI(),
		proto: r.Proto, state: StatePending, reqHeader: header, dial: dial,
	}
	s.mu.Lock()
	s.next++
	f.id = s.next
	init(f)
	s.bytes += int64(len(f.reqBody.Data))
	s.flows = append(s.flows, f)
	s.trim()
	sum := f.summary()
	s.mu.Unlock()
	s.changed(sum)
	return f
}

// update は f を書き換えて知らせる。もう捨てた通信なら何もしない。
func (s *Store) update(f *flow, change func(f *flow)) {
	s.mu.Lock()
	if !slices.Contains(s.flows, f) {
		s.mu.Unlock()
		return
	}
	before := int64(len(f.reqBody.Data) + len(f.respBody.Data))
	change(f)
	s.bytes += int64(len(f.reqBody.Data)+len(f.respBody.Data)) - before
	sum := f.summary()
	s.trim()
	s.mu.Unlock()
	s.changed(sum)
}

// trim は上限を超えた分を、古いものから捨てる（いちばん新しい 1 つは残す）。止めている通信（StateHeld）は捨てない
// （パネルから流す・捨てるができなくなるので。止めている数は MaxHeld まで）。
func (s *Store) trim() {
	for len(s.flows) > 1 && (len(s.flows) > MaxFlows || s.bytes > MaxStoreBytes) {
		i := slices.IndexFunc(s.flows[:len(s.flows)-1], func(f *flow) bool { return f.state != StateHeld })
		if i < 0 {
			return
		}
		old := s.flows[i]
		s.bytes -= int64(len(old.reqBody.Data) + len(old.respBody.Data))
		if i == 0 {
			s.flows[0] = nil
			s.flows = s.flows[1:]
		} else {
			s.flows = slices.Delete(s.flows, i, i+1)
		}
	}
}

func (s *Store) changed(sum Summary) {
	if s.onChange != nil {
		s.onChange(sum)
	}
}

func headerList(h http.Header) [][2]string {
	out := [][2]string{}
	for _, k := range slices.Sorted(maps.Keys(h)) {
		for _, v := range h[k] {
			out = append(out, [2]string{k, v})
		}
	}
	return out
}

// viewBody は覚えた本文を見せる形にする。gzip・deflate は展開し、UTF-8 の字として読めるものだけ字で返す。
func viewBody(b Body, h http.Header) BodyView {
	v := BodyView{Size: b.Size, Truncated: b.Truncated}
	data := b.Data
	enc := strings.ToLower(strings.TrimSpace(h.Get("Content-Encoding")))
	switch enc {
	case "", "identity":
	case "gzip", "x-gzip", "deflate":
		decoded, ok := decode(enc, data)
		if !ok {
			v.Binary, v.Encoding = true, enc
			return v
		}
		data = decoded
	default:
		v.Binary, v.Encoding = true, enc
		return v
	}
	if text, ok := asText(data, b.Truncated); ok {
		v.Text = &text
	} else {
		v.Binary = true
	}
	return v
}

// decode は圧縮された本文を展開する（maxDecoded まで）。途中で切れた本文は、読めた所までを返す。
func decode(enc string, data []byte) ([]byte, bool) {
	var r io.Reader
	switch enc {
	case "deflate":
		// deflate は zlib の包みがあるものと、無いもの（生の deflate）の両方が送られてくる
		if zr, err := zlib.NewReader(bytes.NewReader(data)); err == nil {
			r = zr
		} else {
			r = flate.NewReader(bytes.NewReader(data))
		}
	default:
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, len(data) == 0
		}
		r = zr
	}
	out, err := io.ReadAll(io.LimitReader(r, maxDecoded))
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && len(out) == 0 {
		return nil, false
	}
	return out, true
}

// asText は data が UTF-8 の字ならその文字列。切れた本文は、最後の字が途中でもよい。
func asText(data []byte, truncated bool) (string, bool) {
	if bytes.IndexByte(data, 0) >= 0 {
		return "", false
	}
	if utf8.Valid(data) {
		return string(data), true
	}
	if truncated || len(data) >= maxDecoded {
		for cut := 1; cut <= 3 && cut <= len(data); cut++ {
			if utf8.Valid(data[:len(data)-cut]) {
				return string(data[:len(data)-cut]), true
			}
		}
	}
	return "", false
}

// capture は本文を流しながら、先頭の MaxBody だけ覚える。読み終えた・閉じたときに done を 1 回呼ぶ。
type capture struct {
	rc   io.ReadCloser
	mu   sync.Mutex // 読むのと閉じるのが、別の goroutine から来ることがある
	buf  []byte
	size int64
	once sync.Once
	done func(b Body, err error)
}

func (c *capture) Read(p []byte) (int, error) {
	n, err := c.rc.Read(p)
	if n > 0 {
		c.mu.Lock()
		c.size += int64(n)
		if room := MaxBody - len(c.buf); room > 0 {
			c.buf = append(c.buf, p[:min(n, room)]...)
		}
		c.mu.Unlock()
	}
	if err != nil {
		if errors.Is(err, io.EOF) {
			c.finish(nil)
		} else {
			c.finish(err)
		}
	}
	return n, err
}

func (c *capture) Close() error {
	err := c.rc.Close()
	c.finish(nil)
	return err
}

func (c *capture) finish(err error) {
	c.once.Do(func() {
		c.mu.Lock()
		b := Body{Data: slices.Clone(c.buf), Size: c.size, Truncated: c.size > int64(len(c.buf))}
		c.mu.Unlock()
		c.done(b, err)
	})
}

// summaryOf は f の一覧の行。
func (s *Store) summaryOf(f *flow) Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return f.summary()
}
