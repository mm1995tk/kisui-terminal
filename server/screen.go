package server

import (
	"errors"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"

	"github.com/mm1995tk/kisui-terminal/internal/emulator"
)

// maxScreenPending は、エミュレーターが追いつくのを待っている出力をこれ以上は溜めない量。
const maxScreenPending = 4 << 20

// screenFeed は欄の画面の状態を持つ coneko-term。PTY の出力と欄の大きさの変更を、別のゴルーチンで
// 順にエミュレーターへ届ける。pump は write で出力を渡すだけで、エミュレーターを待たない。
//
// エミュレーターは問い合わせに返事をしない（emulator.Emulator.Write が捨てる）。GUI に画面を取り直させるとき（term.attach）は、
// snapshot で状態の書き出しを取る。
//
// 出力が速すぎてエミュレーターが追いつかないとき（yes など）は、PTY の読み取りを遅らせる代わりに、
// 溜まった分を捨ててエミュレーターを始めの状態に戻す（lost に数える）。リングバッファは別にあり、
// GUI に送る出力は変わらない。そのあとの書き出しは、始めの状態から届いた出力だけの画面になる（プログラムが
// 画面を描き直すまで、捨てた分の状態は無い）。
type screenFeed struct {
	log *slog.Logger

	mu      sync.Mutex
	wake    chan struct{} // 仕事ができたことを feeder に知らせる（容量 1）
	ops     []screenOp
	pending int // ops の中の出力の合計バイト数
	reset   bool
	closed  bool
	busy    bool // feeder が取り出した ops を処理している
	em      *emulator.Emulator

	idle sync.Cond // ops が空で busy でなくなったら起こす（テスト用）

	lost    atomic.Int64 // 捨てた出力のバイト数
	dropped atomic.Int64 // エミュレーターが作って捨てた返事のバイト数
}

type screenOp struct {
	data       []byte
	rows, cols int      // data も snap も無ければ大きさの変更
	snap       *snapReq // あれば、ここまでの出力を書き出す
}

// snapReq は画面の状態の書き出しの頼み。feeder が、頼む前に渡された出力と大きさの変更を全部届けたあとで答える。
type snapReq struct {
	max int
	res chan snapResult // 容量 1
}

type snapResult struct {
	data []byte
	err  error
}

var errScreenUnavailable = errors.New("screen state is not available")

func newScreenFeed(log *slog.Logger, rows, cols int) *screenFeed {
	f := &screenFeed{log: log, wake: make(chan struct{}, 1)}
	f.idle.L = &f.mu
	go f.run(rows, cols)
	return f
}

// write は出力を渡す（コピーする）。待たない。
func (f *screenFeed) write(p []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	if f.pending+len(p) > maxScreenPending {
		f.lost.Add(int64(f.pending + len(p)))
		// 出力だけを捨てる。大きさの変更は残さないと、エミュレーターの大きさが欄とずれる
		f.ops = slices.DeleteFunc(f.ops, func(op screenOp) bool { return len(op.data) > 0 })
		f.pending = 0
		f.reset = true
		f.signal()
		return
	}
	if n := len(f.ops); n > 0 && len(f.ops[n-1].data) > 0 {
		f.ops[n-1].data = append(f.ops[n-1].data, p...)
	} else {
		f.ops = append(f.ops, screenOp{data: append(make([]byte, 0, max(len(p), 4096)), p...)})
	}
	f.pending += len(p)
	f.signal()
}

// snapshot は、ここまでに渡した出力と大きさの変更を全部届けた時点の、画面の状態の書き出しを頼む。
// 待たない。答えは返したチャンネルに 1 つだけ来る（エミュレーターが無い・閉じたあとなら err）。
// 頼んだ時点と出力の位置（seq）を合わせたい呼び手は、write と同じロックの中で呼ぶ。
func (f *screenFeed) snapshot(maxScrollback int) <-chan snapResult {
	req := &snapReq{max: maxScrollback, res: make(chan snapResult, 1)}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		req.res <- snapResult{err: errScreenUnavailable}
		return req.res
	}
	f.ops = append(f.ops, screenOp{snap: req})
	f.signal()
	return req.res
}

// failSnapshots は、溜まっている書き出しの頼みに失敗を答える。mu を持って呼ぶ。
func failSnapshots(ops []screenOp) {
	for _, op := range ops {
		if op.snap != nil {
			op.snap.res <- snapResult{err: errScreenUnavailable}
		}
	}
}

// resize は欄の大きさの変更を、それまでの出力のあとに届ける。
func (f *screenFeed) resize(rows, cols int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.ops = append(f.ops, screenOp{rows: rows, cols: cols})
	f.signal()
}

// signal は mu を持って呼ぶ。
func (f *screenFeed) signal() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// close は feeder を止めてエミュレーターを閉じる。何度呼んでもよい。
func (f *screenFeed) close() {
	f.mu.Lock()
	f.closed = true
	failSnapshots(f.ops)
	f.ops, f.pending = nil, 0
	f.signal()
	f.idle.Broadcast()
	f.mu.Unlock()
}

// wait は、渡した出力と大きさの変更を全部エミュレーターへ届け終えるまで待つ（テスト用）。
func (f *screenFeed) wait() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for !f.closed && (len(f.ops) > 0 || f.busy || f.reset) {
		f.idle.Wait()
	}
}

func (f *screenFeed) run(rows, cols int) {
	em, err := emulator.New(rows, cols)
	if err != nil {
		// 画面の状態が無くても欄は動く。出力は捨てる
		f.log.Error("screen emulator unavailable", "err", err)
		f.mu.Lock()
		f.closed = true
		failSnapshots(f.ops)
		f.ops = nil
		f.idle.Broadcast()
		f.mu.Unlock()
		return
	}
	defer em.Close()
	f.mu.Lock()
	f.em = em
	f.mu.Unlock()
	for range f.wake {
		for {
			f.mu.Lock()
			if f.closed {
				f.mu.Unlock()
				return
			}
			ops, reset := f.ops, f.reset
			f.ops, f.pending, f.reset = nil, 0, false
			f.busy = len(ops) > 0 || reset
			if !f.busy {
				f.idle.Broadcast()
				f.mu.Unlock()
				break
			}
			f.mu.Unlock()
			if reset {
				_ = em.Reset()
			}
			for _, op := range ops {
				if op.snap != nil {
					data, err := em.Serialize(op.snap.max)
					op.snap.res <- snapResult{data: data, err: err}
				} else if len(op.data) > 0 {
					n, err := em.Write(op.data)
					if err != nil {
						f.log.Error("screen emulator write", "err", err)
					}
					f.dropped.Add(int64(n))
				} else if err := em.Resize(op.rows, op.cols); err != nil {
					f.log.Error("screen emulator resize", "err", err)
				}
			}
			f.mu.Lock()
			f.busy = false
			f.idle.Broadcast()
			f.mu.Unlock()
		}
	}
}
