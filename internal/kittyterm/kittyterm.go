// Package kittyterm is how the kisui commands that run in a pane ("kisui
// notify", "kisui clipboard copy" and "kisui clipboard paste") reach the
// computer the GUI runs on: they write kitty's terminal protocols to the
// terminal they run in, the desktop notifications (OSC 99) and the clipboard
// (OSC 5522), and read the answer from it. kisui serve relays the bytes of a
// pane to the GUI as they are, and the coneko-term of the GUI turns them into a
// notification or a clipboard of that computer (and asks the user before a
// program reads the clipboard). So it works in the panes of a remote machine
// the same, and kisui serve takes no part in it.
//
// See https://sw.kovidgoyal.net/kitty/desktop-notifications/ and
// https://sw.kovidgoyal.net/kitty/clipboard/.
package kittyterm

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// TextMime is the one kind of data the clipboard commands copy and paste.
const TextMime = "text/plain"

// chunk is the size of the data in one packet of a write, before base64 (it
// becomes 4096 bytes, the most the protocol allows in a packet).
const chunk = 3072

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// NewID is a fresh id of a request: the answers carry it, so the command takes
// only the answers to its own request.
func NewID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "kisui-" + hex.EncodeToString(b)
}

// Notification is the OSC 99 that shows text as the title of a desktop
// notification. The text is in base64 (e=1), so it may hold any character.
func Notification(text string) []byte {
	return []byte("\x1b]99;e=1;" + b64([]byte(text)) + "\x1b\\")
}

// ClipboardWrite is the OSC 5522 that puts data (text) on the clipboard. The
// terminal answers it with a packet of type=write and status=DONE (or an
// error), which WriteReply reads.
func ClipboardWrite(id string, data []byte) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "\x1b]5522;type=write:id=%s\x1b\\", id)
	mime := b64([]byte(TextMime))
	if len(data) == 0 {
		fmt.Fprintf(&b, "\x1b]5522;type=wdata:mime=%s\x1b\\", mime)
	}
	for len(data) > 0 {
		n := min(chunk, len(data))
		fmt.Fprintf(&b, "\x1b]5522;type=wdata:mime=%s;%s\x1b\\", mime, b64(data[:n]))
		data = data[n:]
	}
	b.WriteString("\x1b]5522;type=wdata\x1b\\")
	return b.Bytes()
}

// ClipboardRead is the OSC 5522 that asks for the text on the clipboard. The
// terminal answers with packets of type=read (status OK, DATA and DONE, or an
// error), which TextReply reads.
func ClipboardRead(id string) []byte {
	return []byte("\x1b]5522;type=read:id=" + id + ";" + b64([]byte(TextMime)) + "\x1b\\")
}

// Packet is one OSC 5522 from the terminal: its keys (type, status, id, mime)
// and its payload.
type Packet struct {
	Meta    map[string]string
	Payload string
}

func parsePacket(body string) Packet {
	meta, payload, _ := strings.Cut(body, ";")
	p := Packet{Meta: map[string]string{}, Payload: payload}
	for kv := range strings.SplitSeq(meta, ":") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			p.Meta[k] = v
		}
	}
	return p
}

// maxOSC is the longest OSC the Scanner keeps. The answers are much shorter
// (a packet holds at most 4096 bytes of base64); a longer one is dropped.
const maxOSC = 64 * 1024

// Scanner picks the OSC 5522 packets out of the bytes the terminal sends.
// Anything else (keys the user types meanwhile, other answers) is dropped.
type Scanner struct {
	state int // 0 outside, 1 after ESC, 2 in an OSC, 3 after ESC in an OSC
	buf   []byte
	over  bool
}

// Feed reads b and returns the packets it completed.
func (s *Scanner) Feed(b []byte) []Packet {
	var out []Packet
	end := func() {
		if !s.over {
			if body, ok := strings.CutPrefix(string(s.buf), "5522;"); ok {
				out = append(out, parsePacket(body))
			}
		}
		s.buf, s.over, s.state = s.buf[:0], false, 0
	}
	for _, c := range b {
		switch s.state {
		case 0:
			if c == 0x1b {
				s.state = 1
			}
		case 1:
			switch c {
			case ']':
				s.state = 2
			case 0x1b:
			default:
				s.state = 0
			}
		case 2:
			switch c {
			case 0x07: // BEL ends an OSC too
				end()
			case 0x1b:
				s.state = 3
			default:
				if len(s.buf) < maxOSC {
					s.buf = append(s.buf, c)
				} else {
					s.over = true
				}
			}
		case 3:
			if c == '\\' {
				end()
				continue
			}
			// an ESC that does not end the OSC breaks it off; it may begin another
			s.buf, s.over = s.buf[:0], false
			s.state = 1
			if c == ']' {
				s.state = 2
			}
		}
	}
	return out
}

// StatusError is the error the terminal answered with: EPERM (the user did not
// allow it), EBUSY, ENOSYS, EIO, EINVAL or EFBIG.
type StatusError struct{ Status string }

func (e *StatusError) Error() string { return "the terminal answered " + e.Status }

// WriteReply returns the function that reads the answer to the ClipboardWrite
// with id: done is true when it came, with its error.
func WriteReply(id string) func(Packet) (bool, error) {
	return func(p Packet) (bool, error) {
		if p.Meta["type"] != "write" || p.Meta["id"] != id {
			return false, nil
		}
		if s := p.Meta["status"]; s != "DONE" {
			return true, &StatusError{s}
		}
		return true, nil
	}
}

// TextReply collects the answer to the ClipboardRead with ID.
type TextReply struct {
	ID   string
	Text []byte
}

// Handle reads p: done is true when the answer ended, with its error. When the
// clipboard holds no text, it ends with no Text and no error.
func (r *TextReply) Handle(p Packet) (bool, error) {
	if p.Meta["type"] != "read" || p.Meta["id"] != r.ID {
		return false, nil
	}
	switch s := p.Meta["status"]; s {
	case "OK":
		return false, nil
	case "DATA":
		mime, err := base64.StdEncoding.DecodeString(p.Meta["mime"])
		if err != nil || string(mime) != TextMime {
			return false, nil
		}
		data, err := base64.StdEncoding.DecodeString(p.Payload)
		if err != nil {
			return true, fmt.Errorf("the terminal sent data that is not base64: %w", err)
		}
		r.Text = append(r.Text, data...)
		return false, nil
	case "DONE":
		return true, nil
	default:
		return true, &StatusError{s}
	}
}

// Image is the APC sequence of kitty's graphics protocol that shows a PNG at
// the cursor (a=T, f=100), in packets of at most 4096 bytes of base64 (m=1
// until the last). cols is how many cells wide it is drawn (0: the size of the
// image in pixels); the rows follow from the aspect ratio. q=2 keeps the
// terminal from answering, so nothing is left on the input of the shell.
func Image(png []byte, cols int) []byte {
	var b bytes.Buffer
	data := b64(png)
	first := true
	for {
		n := min(4096, len(data))
		more := 0
		if n < len(data) {
			more = 1
		}
		if first {
			fmt.Fprintf(&b, "\x1b_Ga=T,f=100,q=2,m=%d", more)
			if cols > 0 {
				fmt.Fprintf(&b, ",c=%d", cols)
			}
			first = false
		} else {
			fmt.Fprintf(&b, "\x1b_Gq=2,m=%d", more)
		}
		b.WriteString(";" + data[:n] + "\x1b\\")
		data = data[n:]
		if more == 0 {
			return b.Bytes()
		}
	}
}
