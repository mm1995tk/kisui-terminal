package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Handler は相手から来た要求・通知を受ける。
//
// 通知（req.IsNotification）は読んだ順に 1 件ずつ、読みの goroutine の中で呼ばれる。
// 戻り値は捨てられる。重い処理はここでしない（読みが止まる）。
// ここから Conn.Call してはいけない（応答を読む人がいなくなり、必ず詰まる）。必要なら別の goroutine で呼ぶ。
//
// 要求は 1 件ごとに別の goroutine で呼ばれ、戻り値が応答になる。ただし Options.Ordered が true を返す
// メソッドの要求は、読んだ順に 1 件ずつ（前のが返ってから次を）呼ばれる。
// result は json.Marshal できる値。err が *Error ならそのまま、それ以外は CodeInternalError にする。
// ctx は接続が閉じると取り消される。要求の Handler の中からは Conn.Call してもよい。
type Handler func(ctx context.Context, req *Message) (result any, err error)

// ErrClosed は閉じた接続に使ったときのエラー。
var ErrClosed = errors.New("rpc: connection closed")

// Conn は 1 本の接続。要求と応答を id で対応づけ、書きは直列にする。
type Conn struct {
	codec   Codec
	closer  io.Closer
	handler Handler

	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	nextID  int64
	pending map[string]chan *Message
	closed  bool
	err     error // 読みが終わった理由

	done chan struct{} // 読みが終わると閉じる
	wg   sync.WaitGroup

	ordered  func(method string) bool // Options.Ordered
	queue    []*Message               // 順に処理する要求の待ち（mu で守る）
	draining bool                     // queue を処理する goroutine が動いている（mu で守る）
}

// Options は NewConnWith に渡すもの。
type Options struct {
	// Ordered が true を返すメソッドの要求は、読んだ順に 1 件ずつ処理する（入力のように順が意味を持つもの）。
	// それ以外の要求とは並んで動く。nil ならすべての要求を別々の goroutine で処理する。
	Ordered func(method string) bool
}

// NewConn は rwc の上に enc で接続を作り、読みを始める。h は nil でもよい（来た要求には method_not_found を返す）。
// 閉じるときは Close を呼ぶ（rwc も閉じる）。
func NewConn(rwc io.ReadWriteCloser, enc Encoding, h Handler) *Conn {
	return NewConnWith(rwc, enc, h, Options{})
}

// NewConnWith は NewConn に Options を足したもの。
func NewConnWith(rwc io.ReadWriteCloser, enc Encoding, h Handler, o Options) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		codec:   enc.NewCodec(rwc, rwc),
		closer:  rwc,
		handler: h,
		ctx:     ctx,
		cancel:  cancel,
		pending: map[string]chan *Message{},
		done:    make(chan struct{}),
		ordered: o.Ordered,
	}
	go c.readLoop()
	return c
}

// Done は読みが終わる（相手が閉じた、壊れた、Close した）と閉じる。
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err は読みが終わった理由を返す。相手が普通に閉じたときは io.EOF。Done が閉じる前は nil。
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close は接続を閉じる。待っている Call は ErrClosed で戻る。実行中の Handler の終わりも待つ。
// Handler の中から呼んではいけない（自分を待って詰まる）。閉じるなら別の goroutine で。
func (c *Conn) Close() error {
	c.shutdown(ErrClosed)
	err := c.closer.Close()
	<-c.done
	c.wg.Wait()
	return err
}

// Call は要求を送り、応答を待つ。result が nil でなければ応答の result を読み込む。
// 応答がエラーなら *Error を返す。ctx が先に終われば ctx.Err() を返す（相手の処理は止まらない）。
func (c *Conn) Call(ctx context.Context, method string, params, result any) error {
	p, err := marshalParams(params)
	if err != nil {
		return err
	}
	ch := make(chan *Message, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	c.nextID++
	id := IntID(c.nextID)
	c.pending[id.String()] = ch
	c.mu.Unlock()

	forget := func() {
		c.mu.Lock()
		delete(c.pending, id.String())
		c.mu.Unlock()
	}
	if err := c.codec.Write(&Message{ID: id, Method: method, Params: p}); err != nil {
		forget()
		return err
	}
	select {
	case resp := <-ch:
		if resp == nil {
			return ErrClosed
		}
		if resp.Error != nil {
			return resp.Error
		}
		if result == nil || len(resp.Result) == 0 {
			return nil
		}
		if err := json.Unmarshal(resp.Result, result); err != nil {
			return fmt.Errorf("rpc: decode result of %s: %w", method, err)
		}
		return nil
	case <-ctx.Done():
		forget()
		return ctx.Err()
	}
}

// Notify は通知を送る。返事は来ない。
func (c *Conn) Notify(method string, params any) error {
	p, err := marshalParams(params)
	if err != nil {
		return err
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	return c.codec.Write(&Message{Method: method, Params: p})
}

func marshalParams(params any) (json.RawMessage, error) {
	if params == nil {
		return nil, nil
	}
	b, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("rpc: encode params: %w", err)
	}
	return b, nil
}

// shutdown は閉じた印を付け、待っている Call を起こす。
func (c *Conn) shutdown(reason error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.err = reason
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	c.cancel()
}

func (c *Conn) readLoop() {
	defer close(c.done)
	for {
		m, err := c.codec.Read()
		if err != nil {
			if re, ok := errors.AsType[*Error](err); ok {
				// 1 件が壊れているだけ。id は読めないので null で返して続ける。
				c.reply(&Message{ID: ID("null"), Error: re})
				continue
			}
			c.shutdown(err)
			return
		}
		c.dispatch(m)
	}
}

func (c *Conn) dispatch(m *Message) {
	switch {
	case m.IsResponse():
		c.mu.Lock()
		ch, ok := c.pending[m.ID.String()]
		delete(c.pending, m.ID.String())
		c.mu.Unlock()
		if ok {
			ch <- m // 容量 1 で、1 回しか送らない
		}
	case m.IsNotification():
		if c.handler != nil {
			c.handler(c.ctx, m) //nolint:errcheck // 通知の戻り値は捨てる
		}
	case c.ordered != nil && c.ordered(m.Method):
		c.mu.Lock()
		c.queue = append(c.queue, m)
		start := !c.draining
		c.draining = true
		c.mu.Unlock()
		// Add は読みの goroutine の中なので、Close の Wait（読みが終わってから）より前に来る。
		if start {
			c.wg.Go(c.drain)
		}
	default:
		c.wg.Go(func() {
			c.serve(m)
		})
	}
}

// drain は順に処理する要求を、待ちが空になるまで 1 件ずつ処理する。
func (c *Conn) drain() {
	for {
		c.mu.Lock()
		if len(c.queue) == 0 {
			c.draining = false
			c.mu.Unlock()
			return
		}
		m := c.queue[0]
		c.queue[0] = nil
		c.queue = c.queue[1:]
		c.mu.Unlock()
		c.serve(m)
	}
}

func (c *Conn) serve(req *Message) {
	if c.handler == nil {
		c.reply(&Message{ID: req.ID, Error: Errorf(CodeMethodNotFound, "method not found: %s", req.Method)})
		return
	}
	res, err := c.handler(c.ctx, req)
	if err != nil {
		re, ok := errors.AsType[*Error](err)
		if !ok {
			re = Errorf(CodeInternalError, "%v", err)
		}
		c.reply(&Message{ID: req.ID, Error: re})
		return
	}
	b, err := json.Marshal(res)
	if err != nil {
		c.reply(&Message{ID: req.ID, Error: Errorf(CodeInternalError, "encode result: %v", err)})
		return
	}
	c.reply(&Message{ID: req.ID, Result: b})
}

func (c *Conn) reply(m *Message) {
	// 書けないのは接続が壊れたとき。読みの側でも気づくのでここでは捨てる。
	_ = c.codec.Write(m)
}
