package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/emulator"
)

// term.attach が返す書き出し。
type attachResult struct {
	Seq      int64  `json:"seq"`
	Snapshot string `json:"snapshot"`
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
}

func (a attachResult) snapshot(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(a.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// queries は端末への問い合わせ（DA1・DA2・DECRQM・kitty キーボード・XTVERSION）を出す printf の引数。
const queries = `\033[c\033[>c\033[?2026$p\033[?2027$p\033[?u\033[>q`

// checkSnapshotAsksNothing は、書き出しを新しい端末に書いても返事が出ない（問い合わせが入っていない）ことと、
// 書いた先の端末をもう一度書き出すと同じバイト列になること（状態が書き出しに全部入っている）を確かめる。
// 返事を出すのは GUI の coneko-term なので、これが GUI でシェルに謎の文字が届かない根拠になる。
func checkSnapshotAsksNothing(t *testing.T, snap []byte, rows, cols int) {
	t.Helper()
	em, err := emulator.New(rows, cols)
	if err != nil {
		t.Fatal(err)
	}
	defer em.Close()
	dropped, err := em.Write(snap)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 0 {
		t.Errorf("writing the snapshot made the terminal reply (%d bytes): it contains a query", dropped)
	}
	again, err := em.Serialize(snapshotScrollback)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(again, snap) {
		t.Errorf("snapshot does not reproduce itself: %d bytes vs %d", len(snap), len(again))
	}
}

// TUI のように、起動時に問い合わせを出して、代替画面・マウス・kitty キーボードを使うプログラムが動いているとき、
// つなぎ直し（term.attach）の書き出しに問い合わせは入らず、画面とモードは入る。
func TestTermAttachSnapshotHasNoQueriesAndKeepsModes(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64(
		`printf '` + queries + `\033[?1049h\033[?1000h\033[?1006h\033[?2004h\033[?1h\033[>1u\033[2J\033[HTUI-TOP\033[3;1HTUI-ROW3'; echo; echo MA""RK` + "\n")}, nil)
	waitFor(t, "output", func() bool { out, _ := nt.output(t, id); return bytes.Contains(out, []byte("MARK\r\n")) })

	var a attachResult
	if err := c.Call(ctx, "term.attach", map[string]any{"termId": id}, &a); err != nil {
		t.Fatal(err)
	}
	snap := a.snapshot(t)
	for _, want := range []string{"TUI-TOP", "TUI-ROW3", "\x1b[?1000h", "\x1b[?1006h", "\x1b[?2004h", "\x1b[?1h"} {
		if !bytes.Contains(snap, []byte(want)) {
			t.Errorf("snapshot lacks %q", want)
		}
	}
	checkSnapshotAsksNothing(t, snap, a.Rows, a.Cols)
	// 過去のバイト列は流し直さない（問い合わせの文字列が、書き出しのどこにも無い）
	for _, q := range []string{"\x1b[c", "\x1b[>c", "\x1b[?u", "\x1b[>q"} {
		if bytes.Contains(snap, []byte(q)) {
			t.Errorf("snapshot contains the query %q", q)
		}
	}
}

// 出力が溢れて欠けたあとの取り直し（ack が無いまま ring を超える）でも、書き出しに問い合わせは入らない。
// ring には先頭の問い合わせがもう残っていないが、画面の状態は ring によらない。
func TestTermAttachAfterOverflowHasNoQueries(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64(
		`printf '` + queries + `\033[?1049h\033[?1000h'; head -c 2097152 /dev/zero | tr '\0' 'a'; printf '` + queries + `\r\nEND'` + "\n")}, nil)
	waitFor(t, "first window", func() bool { _, last := nt.output(t, id); return last >= ackWindow })
	var a attachResult
	waitFor(t, "overflow", func() bool {
		if err := c.Call(ctx, "term.attach", map[string]any{"termId": id}, &a); err != nil {
			t.Fatal(err)
		}
		return a.Seq >= 2<<20
	})
	// 続きの出力がすべて入るまで待ち直す
	waitFor(t, "END in the snapshot", func() bool {
		if err := c.Call(ctx, "term.attach", map[string]any{"termId": id}, &a); err != nil {
			t.Fatal(err)
		}
		return bytes.Contains(a.snapshot(t), []byte("END"))
	})
	checkSnapshotAsksNothing(t, a.snapshot(t), a.Rows, a.Cols)
}

// 書き出しの seq と、そのあとの term.output が、抜けも重なりもなくつながる。
func TestTermAttachSeqJoinsOutput(t *testing.T) {
	_, sock := start(t)
	c, nt := termClient(t, sock)
	ctx := context.Background()
	id := createTerm(t, c, nil)
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("printf BEFORE\n")}, nil)
	waitFor(t, "before", func() bool { out, _ := nt.output(t, id); return bytes.Contains(out, []byte("BEFORE\r\n")) })

	var a attachResult
	if err := c.Call(ctx, "term.attach", map[string]any{"termId": id}, &a); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(a.snapshot(t), []byte("BEFORE")) {
		t.Fatalf("snapshot lacks BEFORE")
	}
	c.Call(ctx, "term.input", map[string]any{"termId": id, "data": b64("printf AFTER\n")}, nil)
	waitFor(t, "after", func() bool { out, _ := nt.output(t, id); return bytes.Contains(out, []byte("AFTER\r\n")) })

	// attach より先の出力は、seq が a.Seq の次から始まる
	nt.mu.Lock()
	defer nt.mu.Unlock()
	next := a.Seq
	for _, m := range nt.got {
		if m.Method != "term.output" {
			continue
		}
		var p struct {
			TermID string `json:"termId"`
			Seq    int64  `json:"seq"`
			Data   string `json:"data"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			t.Fatal(err)
		}
		data, _ := base64.StdEncoding.DecodeString(p.Data)
		if p.TermID != id || p.Seq <= a.Seq { // ワークスペースのプライマリターミナルの出力も届く
			continue
		}
		if start := p.Seq - int64(len(data)); start != next {
			t.Fatalf("output starts at %d, want %d", start, next)
		}
		next = p.Seq
	}
	if next == a.Seq {
		t.Fatal("no output after the snapshot")
	}
}

func TestTermAttachFailsWhenScreenIsClosed(t *testing.T) {
	srv, sock := start(t)
	c, _ := termClient(t, sock)
	id := createTerm(t, c, nil)
	tm, err := srv.terms.get(id)
	if err != nil {
		t.Fatal(err)
	}
	tm.feed.close()
	if err := c.Call(context.Background(), "term.attach", map[string]any{"termId": id}, nil); err == nil {
		t.Error("attach succeeded without a screen state; it must not fall back to the raw bytes")
	}
}
