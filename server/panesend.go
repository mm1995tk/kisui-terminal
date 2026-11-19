package server

// ほかのペインに文字・キーを送り、閉じる（kisui pane send / keys / close。#341）。設計は docs/design/gui-protocol.md の
// 「ペインの中のコマンド」。
//
// 相手は名前か id で指す（termManager.find。このマシンのどのワークスペース・タブのペインでもよい）。フォーカスは移さない。
// 送る文字とキーは、相手のプログラムが今どのモードか（bracketed paste・カーソルキーのアプリケーションモード）に合わせて
// バイト列にする。モードは PTY の出力から拾う（modeScan）。

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// 断る理由（errors.Is で見分けられる）。
var (
	errSendControl  = errors.New("the text has a control character (send keys such as esc or ctrl+c with kisui pane keys)")
	errSendTooLong  = errors.New("the text is too long")
	errSendInvalid  = errors.New("the text is not valid UTF-8")
	errNoKeys       = errors.New("no key to send")
	errUnknownKey   = errors.New("unknown key")
	errPaneEnded    = errors.New("the program of the pane has ended")
	errClosePrimary = errors.New("the primary terminal of a tab is not closed by itself: it closes with its tab (close the tab in the window)")
)

// maxSendText は kisui pane send で 1 度に送れる文字の長さ（バイト）。
const maxSendText = 64 << 10

// sendGap は、続けて送るものの間に置く時間。Esc のあとにすぐ文字が来ると Alt を押した文字と取られ、
// 貼り付けた文字のすぐあとの Enter を貼り付けの一部と取るプログラムもあるので、少し空ける。
const sendGap = 50 * time.Millisecond

// sendWriteTimeout は、相手のプログラムが入力を読まずに PTY が詰まっているとき、書くのをあきらめるまでの時間。
const sendWriteTimeout = 5 * time.Second

// sendText は kisui pane send。text を打ち、Enter を押す。相手のプログラムが bracketed paste を有効にしていれば、
// 貼り付けとして送る（改行を含む文字が途中で実行されないように）。改行は Enter（CR）にする（貼り付けと同じ）。
func (m *termManager) sendText(target, text string) (string, error) {
	if !utf8.ValidString(text) {
		return "", errSendInvalid
	}
	if len(text) > maxSendText {
		return "", fmt.Errorf("%w (at most %d bytes)", errSendTooLong, maxSendText)
	}
	if strings.ContainsFunc(text, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) {
		return "", errSendControl
	}
	t, err := m.find(target)
	if err != nil {
		return "", err
	}
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r")
	t.inputMu.Lock()
	defer t.inputMu.Unlock()
	t.mu.Lock()
	paste := t.modes.bracketedPaste
	t.mu.Unlock()
	var chunks [][]byte
	if text != "" {
		if paste {
			chunks = append(chunks, []byte("\x1b[200~"+text+"\x1b[201~"))
		} else {
			chunks = append(chunks, []byte(text))
		}
	}
	chunks = append(chunks, []byte{'\r'})
	return t.id, t.typeIn(chunks)
}

// sendKeys は kisui pane keys。keys（keyBytes の名前）を順に押す。1 つでも知らない名前があれば、何も送らずに断る。
func (m *termManager) sendKeys(target string, keys []string) (string, error) {
	if len(keys) == 0 {
		return "", errNoKeys
	}
	for _, k := range keys {
		if _, ok := keyBytes(k, false); !ok {
			return "", fmt.Errorf("%w: %q (known keys: %s)", errUnknownKey, k, knownKeys)
		}
	}
	t, err := m.find(target)
	if err != nil {
		return "", err
	}
	t.inputMu.Lock()
	defer t.inputMu.Unlock()
	t.mu.Lock()
	app := t.modes.appCursor
	t.mu.Unlock()
	chunks := make([][]byte, 0, len(keys))
	for _, k := range keys {
		b, _ := keyBytes(k, app)
		chunks = append(chunks, b)
	}
	return t.id, t.typeIn(chunks)
}

// typeIn は chunks を順に PTY に書く（間に sendGap を置く）。inputMu を持って呼ぶ。
func (t *terminal) typeIn(chunks [][]byte) error {
	if !t.isAlive() {
		return fmt.Errorf("%w: %s", errPaneEnded, t.id)
	}
	ptmx, _ := t.proc()
	for i, b := range chunks {
		if i > 0 {
			time.Sleep(sendGap)
		}
		_ = ptmx.SetWriteDeadline(time.Now().Add(sendWriteTimeout)) // 読まれない PTY で止まり続けないように（できなければそのまま）
		_, err := ptmx.Write(b)
		_ = ptmx.SetWriteDeadline(time.Time{})
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return fmt.Errorf("the program of the pane does not read its input: %s", t.id)
		}
		if err != nil {
			return fmt.Errorf("%w: %s", errPaneEnded, t.id)
		}
	}
	return nil
}

// closeByName は kisui pane close。プライマリターミナルは閉じない（タブといっしょに閉じる。GUI の term.close と同じ）。
func (w *wsManager) closeByName(target string) (string, error) {
	t, err := w.srv.terms.find(target)
	if err != nil {
		return "", err
	}
	if !w.closeSplit(t.id) {
		return "", fmt.Errorf("%w: %s", errClosePrimary, t.id)
	}
	w.recompute() // workspace.changed で GUI に届き、ペインが消える
	return t.id, nil
}

// fixedKeys は、モードによらないキーのバイト列。
var fixedKeys = map[string]string{
	"enter": "\r", "tab": "\t", "shift+tab": "\x1b[Z", "esc": "\x1b", "backspace": "\x7f", "space": " ",
	"delete": "\x1b[3~", "insert": "\x1b[2~", "pageup": "\x1b[5~", "pagedown": "\x1b[6~",
	"f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS", "f5": "\x1b[15~", "f6": "\x1b[17~",
	"f7": "\x1b[18~", "f8": "\x1b[19~", "f9": "\x1b[20~", "f10": "\x1b[21~", "f11": "\x1b[23~", "f12": "\x1b[24~",
	"ctrl+space": "\x00", `ctrl+\`: "\x1c", "ctrl+]": "\x1d",
}

// cursorKeys は、カーソルキーのアプリケーションモード（DECCKM）で送り方が変わるキーの、最後の文字。
var cursorKeys = map[string]byte{"up": 'A', "down": 'B', "right": 'C', "left": 'D', "home": 'H', "end": 'F'}

// keyAliases は、同じキーの別の書き方。
var keyAliases = map[string]string{"escape": "esc", "return": "enter", "bs": "backspace", "del": "delete", "pgup": "pageup", "pgdn": "pagedown"}

// knownKeys は、断るときに出すキーの一覧。
var knownKeys = "enter, tab, shift+tab, esc, backspace, delete, insert, space, up, down, left, right, home, end, pageup, pagedown, f1-f12, ctrl+a-ctrl+z, ctrl+space, ctrl+\\, ctrl+]"

// keyBytes は、キーの名前（大文字小文字は問わない）を、ターミナルがそのキーで送るバイト列にする。app は
// カーソルキーのアプリケーションモード。知らない名前なら false。
func keyBytes(name string, app bool) ([]byte, bool) {
	k := strings.ToLower(strings.TrimSpace(name))
	if a, ok := keyAliases[k]; ok {
		k = a
	}
	if s, ok := fixedKeys[k]; ok {
		return []byte(s), true
	}
	if c, ok := cursorKeys[k]; ok {
		if app {
			return []byte{0x1b, 'O', c}, true
		}
		return []byte{0x1b, '[', c}, true
	}
	if l, ok := strings.CutPrefix(k, "ctrl+"); ok && len(l) == 1 && l[0] >= 'a' && l[0] <= 'z' {
		return []byte{l[0] - 'a' + 1}, true
	}
	return nil, false
}

// modeScan は出力の流れから、送り方に関わるモード（DECSET / DECRST の 1 と 2004）だけを拾う。画面は作らない。
// 引き継ぎのあとは、受け取った画面の状態の書き出し（モードを立てる列を含む）を読ませて戻す。
type modeScan struct {
	state  int // 0 通常, 1 ESC の次, 2 CSI の中
	priv   bool
	bad    bool
	params []byte

	bracketedPaste bool // ?2004
	appCursor      bool // ?1（DECCKM）
}

// maxModeParams は CSI の引数として覚える長さ。これより長い列は見ない。
const maxModeParams = 64

func (s *modeScan) feed(b []byte) {
	for _, c := range b {
		switch s.state {
		case 0:
			if c == 0x1b {
				s.state = 1
			}
		case 1:
			switch c {
			case '[':
				s.state, s.priv, s.bad, s.params = 2, false, false, s.params[:0]
			case 'c': // RIS（全部を始めの状態に）
				s.bracketedPaste, s.appCursor = false, false
				s.state = 0
			case 0x1b:
			default:
				s.state = 0
			}
		case 2:
			switch {
			case c == '?' && len(s.params) == 0 && !s.priv && !s.bad:
				s.priv = true
			case c >= '0' && c <= '9' || c == ';':
				if len(s.params) < maxModeParams {
					s.params = append(s.params, c)
				} else {
					s.bad = true
				}
			case c >= 0x20 && c <= 0x3f: // ほかの引数・中間の文字（"\x1b[>1u" など）
				s.bad = true
			case c >= 0x40 && c <= 0x7e:
				if s.priv && !s.bad && (c == 'h' || c == 'l') {
					s.set(c == 'h')
				}
				s.state = 0
			case c == 0x1b:
				s.state = 1
			case c == 0x18 || c == 0x1a: // CAN・SUB は列を取り消す
				s.state = 0
			}
		}
	}
}

func (s *modeScan) set(on bool) {
	for p := range strings.SplitSeq(string(s.params), ";") {
		switch p {
		case "1":
			s.appCursor = on
		case "2004":
			s.bracketedPaste = on
		}
	}
}
