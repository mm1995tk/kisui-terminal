package main

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"os"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
	"golang.org/x/sys/unix"

	"github.com/mm1995tk/kisui-terminal/internal/kittyterm"
)

// maxInlineBytes is the largest image "kisui open" sends to the terminal itself
// (the file, and the PNG made from it): the bytes go through the pty (and, in a
// remote pane, ssh) in base64. A bigger one opens in a pane, which has the limit
// of the pane. It is a variable so that a test can make it small.
var maxInlineBytes = 16 << 20

const (
	// maxInlineSide is the longest side coneko-term takes (the same as kitty).
	maxInlineSide = 10000
	// guessCellWidth is the width of a cell in pixels when the terminal does
	// not say its size in pixels.
	guessCellWidth = 10
)

// inlineImage is the escape sequence that shows the image file at path in the
// terminal of fd (stdout) at the cursor, and a newline after it: ok is false
// when it cannot be shown that way, and the caller opens the pane instead.
// That is when fd is not a terminal (a pipe, the shell of a coding agent), the
// file is not an image of PNG, JPEG, GIF (the first frame), WebP or BMP (SVG
// and AVIF are not), or it is too big. A PNG is sent as it is, the others as a
// PNG made from them. The image is as wide as it is in pixels, or as wide as
// the terminal when it is wider.
func inlineImage(fd int, path string) (seq []byte, ok bool) {
	ws, err := unix.IoctlGetWinsize(fd, unix.TIOCGWINSZ)
	if err != nil {
		return nil, false
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	// The header says whether it is an image before the whole file is read (a
	// video or a big PDF is left to the pane without reading it).
	cfg, format, err := image.DecodeConfig(f)
	if err != nil || cfg.Width > maxInlineSide || cfg.Height > maxInlineSide {
		return nil, false
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(maxInlineBytes)+1))
	if err != nil || len(data) > maxInlineBytes {
		return nil, false
	}
	if format != "png" {
		img, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, false
		}
		var b bytes.Buffer
		if err := png.Encode(&b, img); err != nil {
			return nil, false
		}
		data = b.Bytes()
		if len(data) > maxInlineBytes { // a PNG made from a JPEG is many times bigger
			return nil, false
		}
	}
	cols := 0
	if ws.Col > 0 {
		cell := guessCellWidth
		if ws.Xpixel > 0 {
			cell = max(1, int(ws.Xpixel)/int(ws.Col))
		}
		cols = min(int(ws.Col), (cfg.Width+cell-1)/cell)
	}
	return append(kittyterm.Image(data, cols), '\n'), true
}
