package proxy

// 記録した通信の要求を書き換えて、プロキシから送り直す（#410）。送り直した要求と応答は、同じ記録に新しい通信として
// 足す（Summary.ResentFrom に元の通信の id）。応答はクライアント（ページ・シェル）には返さず、記録に残すだけ。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// MaxResending は、1 つのプロキシで同時に送り直している（応答を受けている）通信の数の上限。
// 終わらない応答（SSE など）を何度も送り直して、受ける処理が溜まり続けないように。
const MaxResending = 16

// 送り直しの断り方。
var (
	// ErrNoRecord は、記録しないプロキシ（Store が無い）。
	ErrNoRecord = errors.New("this proxy does not record")
	// ErrNoFlow は、元の通信をもう覚えていない。
	ErrNoFlow = errors.New("no such exchange")
	// ErrBodyCut は、本文を書き換えずに送り直そうとしたが、覚えた本文が上限（MaxBody）で切れている。
	ErrBodyCut = errors.New("the body of the request was cut at the limit of the record, so it cannot be sent as it was; replace it")
	// ErrBusy は、同時に送り直している数が上限（MaxResending）。
	ErrBusy = errors.New("too many requests are being resent")
)

// InvalidRequestError は、書き換えた要求の形が正しくない（メソッド・URL・ヘッダー）。
type InvalidRequestError struct{ Reason string }

func (e *InvalidRequestError) Error() string { return e.Reason }

func invalid(format string, a ...any) error {
	return &InvalidRequestError{Reason: fmt.Sprintf(format, a...)}
}

// Resend は送り直す要求。
type Resend struct {
	// From は元の通信の id。
	From int64
	// Method・URL（http か https の絶対 URL）・Header（名前と値の並び。同じ名前を何度書いてもよい）は、送るもの。
	// Header の Host は、URL のホストの代わりに Host として送る。Content-Length・Transfer-Encoding は、本文から決めるので見ない。
	Method string
	URL    string
	Header [][2]string
	// Body は送る本文。nil なら、元の通信の本文を覚えたまま送る（字でない本文・圧縮した本文もそのまま送れる）。
	Body *[]byte
}

// Resend は、記録した通信 r.From の要求を r のとおりに書き換えて送る。送り始めた通信の一覧の行を返し、応答は記録に入る
// （受け終わるまで、知らせ（Store の onChange）が続く）。行き先へは、クライアントの通信と同じく直接つなぐ。
func (p *Proxy) Resend(r Resend) (Summary, error) {
	if p.store == nil {
		return Summary{}, ErrNoRecord
	}
	orig, ok := p.store.request(r.From)
	if !ok {
		return Summary{}, ErrNoFlow
	}
	req, err := p.prepare(r, orig.body)
	if err != nil {
		return Summary{}, err
	}
	return p.sendRecorded(req, r.From)
}

// prepare は、r を確かめて、送る要求を作る（記録に残す形。ヘッダーは書いたまま）。orig は元の通信の覚えた本文
// （r.Body が nil のときに送る）。形が違えば InvalidRequestError、元の本文が切れていれば ErrBodyCut。
func (p *Proxy) prepare(r Resend, orig Body) (*http.Request, error) {
	if !isToken(r.Method) {
		return nil, invalid("invalid method %q", r.Method)
	}
	u, err := url.Parse(strings.TrimSpace(r.URL))
	if err != nil {
		return nil, invalid("invalid URL: %v", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, invalid("the URL must start with http:// or https:// and have a host")
	}
	u.Fragment, u.RawFragment = "", ""
	header := http.Header{}
	host := ""
	for _, kv := range r.Header {
		name, value := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		if !isToken(name) {
			return nil, invalid("invalid header name %q", name)
		}
		if strings.ContainsAny(value, "\r\n\x00") {
			return nil, invalid("invalid value of the header %s", name)
		}
		switch http.CanonicalHeaderKey(name) {
		case "Host":
			host = value
		case "Content-Length", "Transfer-Encoding":
		default:
			header.Add(name, value)
		}
	}
	if p.isSelf(withPort(u)) || (host != "" && p.isSelf(withPortOf(host, u.Scheme))) {
		return nil, invalid("the request points at this proxy itself")
	}
	body := orig.Data
	if r.Body != nil {
		body = *r.Body
	} else if orig.Truncated {
		return nil, ErrBodyCut
	}
	req, err := http.NewRequest(r.Method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, invalid("%v", err)
	}
	req.Header = header
	if host != "" {
		req.Host = host
	}
	if len(body) == 0 {
		// 本文の無い要求（GET など）に Content-Length: 0 を付けない
		req.Body, req.GetBody, req.ContentLength = http.NoBody, nil, 0
	}
	return req, nil
}

// sendRecorded は、prepare で作った req を記録に足して（resentFrom が from）、行き先へ送り始める。応答は、別の goroutine で
// 最後まで読んで記録する。同時に送っている数が MaxResending なら ErrBusy。プロキシを閉じると、受けている途中の応答も切る。
func (p *Proxy) sendRecorded(req *http.Request, from int64) (Summary, error) {
	if !p.resending.tryAcquire() {
		return Summary{}, ErrBusy
	}
	f := p.store.beginFrom(req, req.URL.Scheme, req.URL.Host, from)
	sum := p.store.summaryOf(f)
	// 記録には書いたままのヘッダーを残し、送るヘッダーだけを整える（クライアントの通信を記録するときと同じ）
	ctx, cancel := context.WithCancel(context.Background())
	out := req.Clone(ctx)
	if ae := out.Header.Get("Accept-Encoding"); ae != "" {
		out.Header.Set("Accept-Encoding", narrowEncoding(ae))
	}
	if _, ok := out.Header["User-Agent"]; !ok {
		// 書いていない User-Agent を、Go の既定（Go-http-client）で足さない
		out.Header["User-Agent"] = []string{""}
	}
	ex := &exchange{scheme: req.URL.Scheme, host: req.URL.Host, flow: f}
	out = out.WithContext(context.WithValue(ctx, exchangeKey, ex))
	go func() {
		defer p.resending.release()
		defer cancel()
		stop := context.AfterFunc(p.closing, cancel)
		defer stop()
		resp, err := recorder{p}.RoundTrip(out)
		if err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	return sum, nil
}

// withPort は u の host:port（ポートを省いていれば、scheme の既定のポートを付ける）。
func withPort(u *url.URL) string {
	return withPortOf(u.Host, u.Scheme)
}

func withPortOf(host, scheme string) string {
	if _, _, err := net.SplitHostPort(host); err == nil {
		return host
	}
	port := "443"
	if scheme == "http" {
		port = "80"
	}
	return net.JoinHostPort(strings.Trim(host, "[]"), port)
}

// isToken は、s が HTTP の token（メソッド・ヘッダーの名前に使える字だけ。空でない）か。
func isToken(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x80 || c <= ' ' || c == 0x7f || strings.IndexByte(`"(),/:;<=>?@[\]{}`, c) >= 0 {
			return false
		}
	}
	return true
}

// counter は、同時に動いている数を上限までに抑える。
type counter struct{ ch chan struct{} }

func newCounter(n int) counter { return counter{ch: make(chan struct{}, n)} }

func (c counter) tryAcquire() bool {
	select {
	case c.ch <- struct{}{}:
		return true
	default:
		return false
	}
}

func (c counter) release() { <-c.ch }
