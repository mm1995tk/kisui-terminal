package rpc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Codec は線の上でメッセージを 1 件ずつ読み書きする。
// 読みは 1 つの goroutine から、書きは複数の goroutine から呼ばれてよい（書きは Codec の中で直列にする）。
type Codec interface {
	// Read は次の 1 件を返す。終わりは io.EOF。
	// 1 件の形が壊れていて、続きは読めるときは *Error（CodeParseError / CodeInvalidRequest）を返す。
	Read() (*Message, error)
	// Write は 1 件を書く。複数の goroutine から呼んでよい（Codec の中で直列にする）。
	Write(*Message) error
}

// Encoding は分け方（framing）と中身の符号化の組。session.hello の encoding で名前を選び、
// あとで MessagePack（長さ付き）を足せるようにここで差し替える。
type Encoding interface {
	// Name は session.hello の encoding で選ぶ名前。
	Name() string
	// NewCodec は r から読み w に書く Codec を作る。
	NewCodec(r io.Reader, w io.Writer) Codec
}

// DefaultMaxLine は JSON の 1 行の長さの既定の上限。ファイルの中身が 1 件に入るので大きめにしてある。
// bufio.Scanner の既定（64 KiB）では足りない。
const DefaultMaxLine = 64 << 20

// JSON は「1 行 1 メッセージの JSON（改行区切り）」。JSON の文字列の中の改行は \n にエスケープされるので、
// 行の区切りとは衝突しない。
type JSON struct {
	// MaxLine は 1 行の長さの上限（改行を除く）。0 なら DefaultMaxLine。
	MaxLine int
}

// Name は "json" を返す。
func (JSON) Name() string { return "json" }

// NewCodec は r から読み w に書く、改行区切りの JSON の Codec を作る。
func (e JSON) NewCodec(r io.Reader, w io.Writer) Codec {
	max := e.MaxLine
	if max <= 0 {
		max = DefaultMaxLine
	}
	return &lineCodec{r: bufio.NewReader(r), w: w, max: max}
}

type lineCodec struct {
	r   *bufio.Reader
	max int

	mu sync.Mutex // w への書きを直列にする
	w  io.Writer
}

// ErrLineTooLong は 1 行が上限を超えたときのエラー。続きは読めないので接続を閉じるのがよい。
var ErrLineTooLong = errors.New("rpc: line too long")

func (c *lineCodec) Read() (*Message, error) {
	for {
		line, err := c.readLine()
		if err != nil {
			return nil, err
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue // 空行は読み飛ばす
		}
		var m Message
		if err := json.Unmarshal(line, &m); err != nil {
			if re, ok := errors.AsType[*Error](err); ok {
				return nil, re
			}
			return nil, Errorf(CodeParseError, "parse error: %v", err)
		}
		return &m, nil
	}
}

// readLine は改行までを読む。最後に改行が無くても、中身があれば 1 行として返す。
func (c *lineCodec) readLine() ([]byte, error) {
	var buf []byte
	for {
		chunk, err := c.r.ReadSlice('\n')
		if len(buf)+len(chunk) > c.max+1 {
			return nil, ErrLineTooLong
		}
		buf = append(buf, chunk...)
		switch {
		case err == nil:
			return buf, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(buf) > 0:
			return buf, nil
		default:
			return nil, err
		}
	}
}

func (c *lineCodec) Write(m *Message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("rpc: encode: %w", err)
	}
	b = append(b, '\n')
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.w.Write(b)
	return err
}

// Pipe はテスト用に、メモリの上でつながった 2 つの端を返す。
// 片方で書いたものがもう片方で読める。どちらかを Close すると、相手の読みは io.EOF になる。
func Pipe() (a, b io.ReadWriteCloser) {
	r1, w1 := io.Pipe() // a -> b
	r2, w2 := io.Pipe() // b -> a
	return &pipeEnd{r: r2, w: w1}, &pipeEnd{r: r1, w: w2}
}

type pipeEnd struct {
	r *io.PipeReader
	w *io.PipeWriter
}

func (p *pipeEnd) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p *pipeEnd) Write(b []byte) (int, error) { return p.w.Write(b) }
func (p *pipeEnd) Close() error {
	p.r.Close()
	return p.w.Close()
}
