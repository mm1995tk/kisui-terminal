package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func decodeAll(t *testing.T, s string) []*Message {
	t.Helper()
	c := JSON{}.NewCodec(strings.NewReader(s), io.Discard)
	var out []*Message
	for {
		m, err := c.Read()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		out = append(out, m)
	}
}

func TestMessageKinds(t *testing.T) {
	ms := decodeAll(t, `{"jsonrpc":"2.0","id":1,"method":"a","params":{"x":1}}
{"jsonrpc":"2.0","method":"b"}
{"jsonrpc":"2.0","id":"s","result":{"ok":true}}
{"jsonrpc":"2.0","id":2,"result":null}
{"jsonrpc":"2.0","id":3,"error":{"code":-32003,"message":"nope"}}
`)
	if len(ms) != 5 {
		t.Fatalf("got %d messages", len(ms))
	}
	if !ms[0].IsRequest() || ms[0].ID.String() != "1" || string(ms[0].Params) != `{"x":1}` {
		t.Errorf("request: %+v", ms[0])
	}
	if !ms[1].IsNotification() {
		t.Errorf("notification: %+v", ms[1])
	}
	if !ms[2].IsResponse() || ms[2].ID.String() != `"s"` {
		t.Errorf("response: %+v", ms[2])
	}
	if !ms[3].IsResponse() || ms[3].Error != nil {
		t.Errorf("null result: %+v", ms[3])
	}
	if ms[4].Error == nil || ms[4].Error.Code != CodeNotFound {
		t.Errorf("error: %+v", ms[4])
	}
}

func TestInvalidMessages(t *testing.T) {
	for name, line := range map[string]string{
		"not json":     `hello`,
		"no version":   `{"id":1,"method":"a"}`,
		"bad version":  `{"jsonrpc":"1.0","id":1,"method":"a"}`,
		"bad id":       `{"jsonrpc":"2.0","id":{},"method":"a"}`,
		"empty":        `{"jsonrpc":"2.0"}`,
		"id only":      `{"jsonrpc":"2.0","id":1}`,
		"both":         `{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}`,
		"req w/ error": `{"jsonrpc":"2.0","id":1,"method":"a","error":{"code":1,"message":"x"}}`,
	} {
		c := JSON{}.NewCodec(strings.NewReader(line+"\n"), io.Discard)
		_, err := c.Read()
		if _, ok := errors.AsType[*Error](err); !ok {
			t.Errorf("%s: want *Error, got %v", name, err)
		}
	}
}

func TestCodecContinuesAfterBadLine(t *testing.T) {
	c := JSON{}.NewCodec(strings.NewReader("garbage\n\n{\"jsonrpc\":\"2.0\",\"method\":\"ok\"}"), io.Discard)
	if _, err := c.Read(); err == nil {
		t.Fatal("want error")
	}
	m, err := c.Read() // 空行は飛ばし、最後に改行が無くても読める
	if err != nil || m.Method != "ok" {
		t.Fatalf("got %+v, %v", m, err)
	}
	if _, err := c.Read(); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestLongLine(t *testing.T) {
	big := strings.Repeat("あ", 1<<20) // 3 MiB。bufio.Scanner の既定を超える
	var buf bytes.Buffer
	w := JSON{}.NewCodec(strings.NewReader(""), &buf)
	p, _ := json.Marshal(map[string]string{"s": big})
	if err := w.Write(&Message{Method: "m", Params: p}); err != nil {
		t.Fatal(err)
	}
	m, err := JSON{}.NewCodec(&buf, io.Discard).Read()
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(m.Params, &got); err != nil || got["s"] != big {
		t.Fatalf("round trip failed: %v", err)
	}

	small := JSON{MaxLine: 16}.NewCodec(strings.NewReader(strings.Repeat("x", 100)+"\n"), io.Discard)
	if _, err := small.Read(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("want ErrLineTooLong, got %v", err)
	}
}

func TestWriteIsOneLine(t *testing.T) {
	var buf bytes.Buffer
	c := JSON{}.NewCodec(strings.NewReader(""), &buf)
	p, _ := json.Marshal("a\nb")
	_ = c.Write(&Message{ID: IntID(1), Method: "m", Params: p})
	_ = c.Write(&Message{ID: IntID(1)}) // result 無しは null で出る
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 2 || !strings.Contains(lines[1], `"result":null`) {
		t.Fatalf("got %q", buf.String())
	}
}

func pair(t *testing.T, ha, hb Handler) (*Conn, *Conn) {
	t.Helper()
	a, b := Pipe()
	ca, cb := NewConn(a, JSON{}, ha), NewConn(b, JSON{}, hb)
	t.Cleanup(func() { ca.Close(); cb.Close() })
	return ca, cb
}

func TestCallRoundTrip(t *testing.T) {
	ca, _ := pair(t, nil, func(_ context.Context, r *Message) (any, error) {
		switch r.Method {
		case "echo":
			var p struct{ N int }
			if err := json.Unmarshal(r.Params, &p); err != nil {
				return nil, Errorf(CodeInvalidParams, "%v", err)
			}
			return map[string]int{"n": p.N * 2}, nil
		case "missing":
			return nil, Errorf(CodeNotFound, "no such thing")
		case "boom":
			return nil, errors.New("boom")
		}
		return nil, Errorf(CodeMethodNotFound, "method not found: %s", r.Method)
	})
	ctx := context.Background()

	var res struct{ N int }
	if err := ca.Call(ctx, "echo", map[string]int{"N": 21}, &res); err != nil || res.N != 42 {
		t.Fatalf("echo: %+v, %v", res, err)
	}
	var re *Error
	if err := ca.Call(ctx, "missing", nil, nil); !errors.As(err, &re) || re.Code != CodeNotFound {
		t.Fatalf("missing: %v", err)
	}
	if err := ca.Call(ctx, "boom", nil, nil); !errors.As(err, &re) || re.Code != CodeInternalError {
		t.Fatalf("boom: %v", err)
	}
	if err := ca.Call(ctx, "nope", nil, nil); !errors.As(err, &re) || re.Code != CodeMethodNotFound {
		t.Fatalf("nope: %v", err)
	}
}

func TestNoHandlerAnswersMethodNotFound(t *testing.T) {
	ca, _ := pair(t, nil, nil)
	var re *Error
	if err := ca.Call(context.Background(), "x", nil, nil); !errors.As(err, &re) || re.Code != CodeMethodNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestConcurrentCallsAndNestedCall(t *testing.T) {
	var ca, cb *Conn
	ca, cb = pair(t,
		func(ctx context.Context, r *Message) (any, error) { return "pong", nil },
		func(ctx context.Context, r *Message) (any, error) {
			// 要求の処理の中から相手へ呼び返しても詰まらない
			var s string
			if err := cb.Call(ctx, "ping", nil, &s); err != nil {
				return nil, err
			}
			return s, nil
		})
	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			var s string
			if err := ca.Call(context.Background(), "relay", nil, &s); err != nil || s != "pong" {
				t.Errorf("got %q, %v", s, err)
			}
		})
	}
	wg.Wait()
}

func TestNotificationsKeepOrder(t *testing.T) {
	var mu sync.Mutex
	var got []int
	done := make(chan struct{})
	ca, _ := pair(t, nil, func(_ context.Context, r *Message) (any, error) {
		var n int
		_ = json.Unmarshal(r.Params, &n)
		mu.Lock()
		got = append(got, n)
		if len(got) == 100 {
			close(done)
		}
		mu.Unlock()
		return nil, nil
	})
	for i := range 100 {
		if err := ca.Notify("n", i); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}
	for i, n := range got {
		if i != n {
			t.Fatalf("out of order: %v", got)
		}
	}
}

// Requests of the methods Options.Ordered picks run one at a time in the order
// they were read, even when an earlier one takes longer; the others do not wait.
func TestOrderedRequests(t *testing.T) {
	var mu sync.Mutex
	var got []int
	release := make(chan struct{})
	h := func(_ context.Context, r *Message) (any, error) {
		if r.Method == "free" {
			return "free", nil
		}
		var n int
		_ = json.Unmarshal(r.Params, &n)
		if n == 0 {
			<-release
		}
		mu.Lock()
		got = append(got, n)
		mu.Unlock()
		return n, nil
	}
	a, b := Pipe()
	cb := NewConnWith(b, JSON{}, h, Options{Ordered: func(m string) bool { return m == "in" }})
	t.Cleanup(func() { a.Close(); cb.Close() })
	raw := JSON{}.NewCodec(a, a)
	for i := range 20 {
		if err := raw.Write(&Message{ID: IntID(int64(i + 1)), Method: "in", Params: json.RawMessage(fmt.Sprint(i))}); err != nil {
			t.Fatal(err)
		}
	}
	if err := raw.Write(&Message{ID: IntID(100), Method: "free"}); err != nil {
		t.Fatal(err)
	}
	m, err := raw.Read()
	if err != nil || m.ID.String() != "100" {
		t.Fatalf("a request not ordered waited: %+v %v", m, err)
	}
	close(release)
	for range 20 {
		if _, err := raw.Read(); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 20 {
		t.Fatalf("got %v", got)
	}
	for i, n := range got {
		if i != n {
			t.Fatalf("out of order: %v", got)
		}
	}
}

func TestCallContextAndClose(t *testing.T) {
	block := make(chan struct{})
	entered := make(chan struct{}, 2)
	ca, cb := pair(t, nil, func(ctx context.Context, r *Message) (any, error) {
		entered <- struct{}{}
		select {
		case <-block:
		case <-ctx.Done():
		}
		return nil, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := ca.Call(ctx, "slow", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}

	// 相手が閉じると、待っている Call は ErrClosed で戻り、Done が閉じる
	errc := make(chan error, 1)
	go func() { errc <- ca.Call(context.Background(), "slow", nil, nil) }()
	<-entered // 1 回目（時間切れ）の分
	<-entered // 2 回目が Handler に入るまで待つ
	cb.Close()
	select {
	case err := <-errc:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}
	<-ca.Done()
	if err := ca.Notify("x", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("notify after close: %v", err)
	}
	close(block)
}

func TestBadLineGetsParseErrorReply(t *testing.T) {
	a, b := Pipe()
	c := NewConn(b, JSON{}, nil)
	defer c.Close()
	defer a.Close()
	go a.Write([]byte("garbage\n"))
	m, err := JSON{}.NewCodec(a, io.Discard).Read()
	if err != nil || m.Error == nil || m.Error.Code != CodeParseError || !m.ID.IsZero() { // null の id は読むと「無し」になる
		t.Fatalf("got %+v, %v", m, err)
	}
}

func TestErrorNames(t *testing.T) {
	want := map[int]string{
		-32001: "incompatible_protocol", -32002: "not_owner", -32003: "not_found",
		-32004: "denied", -32005: "busy",
	}
	for code, name := range want {
		if CodeName(code) != name {
			t.Errorf("%d: %q", code, CodeName(code))
		}
	}
	if !strings.Contains(Errorf(CodeBusy, "x").Error(), "busy") {
		t.Error("Error() should include the name")
	}
}
