// Package emulator は、coneko-term（GUI と同じ端末エミュレーター）を wasm で動かして、画面の状態を持つ。
// wasm は emulator/ の Rust から作ったもの（scripts/build-emulator.sh）で、wazero で動かす（cgo は使わない）。
//
// エミュレーターは端末の問い合わせ（DA・DECRQM など）に返事をしない。返事を作っても Write が捨てる。
// 返事をするのは GUI の coneko-term だけにするため。
package emulator

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed emulator.wasm
var wasm []byte

// chunk は 1 回で wasm に渡す大きさ。これより長い書き込みは分ける。
const chunk = 64 << 10

var (
	rtOnce   sync.Once
	rt       wazero.Runtime
	compiled wazero.CompiledModule
	rtErr    error
)

// runtime はコンパイルした wasm を全部のエミュレーターで共有する（初めて呼ばれたときに 1 度だけ作る）。
func runtime() (wazero.Runtime, wazero.CompiledModule, error) {
	rtOnce.Do(func() {
		ctx := context.Background()
		rt = wazero.NewRuntime(ctx)
		compiled, rtErr = rt.CompileModule(ctx, wasm)
	})
	return rt, compiled, rtErr
}

// Emulator は端末 1 つ。複数のゴルーチンから呼んでよい（1 つずつ順に動く）。
type Emulator struct {
	mu      sync.Mutex
	mod     api.Module
	fWrite  api.Function
	fResize api.Function
	fSize   api.Function
	fCursor api.Function
	fReset  api.Function
	buf     uint32 // wasm 側の書き込み用の領域（chunk バイト）
	closed  bool
}

// New は rows 行 cols 列のエミュレーターを作る。
func New(rows, cols int) (*Emulator, error) {
	ctx := context.Background()
	r, c, err := runtime()
	if err != nil {
		return nil, fmt.Errorf("compile emulator: %w", err)
	}
	// 名前を空にして、同時にいくつでもインスタンスを作れるようにする
	mod, err := r.InstantiateModule(ctx, c, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, fmt.Errorf("instantiate emulator: %w", err)
	}
	e := &Emulator{
		mod: mod, fWrite: mod.ExportedFunction("em_write"), fResize: mod.ExportedFunction("em_resize"),
		fSize: mod.ExportedFunction("em_size"), fCursor: mod.ExportedFunction("em_cursor"), fReset: mod.ExportedFunction("em_reset"),
	}
	if _, err := mod.ExportedFunction("em_new").Call(ctx, uint64(clampDim(rows)), uint64(clampDim(cols))); err != nil {
		mod.Close(ctx)
		return nil, fmt.Errorf("em_new: %w", err)
	}
	res, err := mod.ExportedFunction("em_alloc").Call(ctx, chunk)
	if err != nil {
		mod.Close(ctx)
		return nil, fmt.Errorf("em_alloc: %w", err)
	}
	e.buf = uint32(res[0])
	return e, nil
}

func clampDim(n int) int { return min(max(n, 1), 1<<15) }

var errClosed = errors.New("emulator is closed")

// Write は PTY の出力を端末に書く。端末が作った返事は捨て、捨てたバイト数を返す。
func (e *Emulator) Write(p []byte) (dropped int, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return 0, errClosed
	}
	ctx := context.Background()
	for len(p) > 0 {
		n := min(len(p), chunk)
		if !e.mod.Memory().Write(e.buf, p[:n]) {
			return dropped, errors.New("emulator memory write out of range")
		}
		res, err := e.fWrite.Call(ctx, uint64(e.buf), uint64(n))
		if err != nil {
			return dropped, fmt.Errorf("em_write: %w", err)
		}
		dropped += int(res[0])
		p = p[n:]
	}
	return dropped, nil
}

// Resize は端末の大きさを変える。
func (e *Emulator) Resize(rows, cols int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errClosed
	}
	_, err := e.fResize.Call(context.Background(), uint64(clampDim(rows)), uint64(clampDim(cols)))
	return err
}

// Size は端末の今の大きさ。
func (e *Emulator) Size() (rows, cols int, err error) {
	return e.pair(e.fSize)
}

// Cursor はカーソルの位置（0 始まりの行と列）。
func (e *Emulator) Cursor() (row, col int, err error) {
	return e.pair(e.fCursor)
}

func (e *Emulator) pair(f api.Function) (hi, lo int, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return 0, 0, errClosed
	}
	res, err := f.Call(context.Background())
	if err != nil {
		return 0, 0, err
	}
	return int(res[0] >> 16 & 0xffff), int(res[0] & 0xffff), nil
}

// Close は wasm のインスタンスを閉じる。何度呼んでもよい。
func (e *Emulator) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.closed = true
	_ = e.mod.Close(context.Background())
}

// Reset は端末を始めの状態に戻す（大きさは変えない）。
func (e *Emulator) Reset() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errClosed
	}
	_, err := e.fReset.Call(context.Background())
	return err
}
