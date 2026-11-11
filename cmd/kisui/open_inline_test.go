package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/creack/pty"
	"golang.org/x/image/bmp"
)

func writeImage(t *testing.T, name string, enc func(*os.File, image.Image) error) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	img.Set(1, 1, color.RGBA{255, 0, 0, 255})
	p := filepath.Join(t.TempDir(), name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := enc(f, img); err != nil {
		t.Fatal(err)
	}
	return p
}

// On a terminal, PNG, JPEG and BMP become the escape sequence of an image, as
// wide as the terminal when they are wider. SVG, a file that is not an image
// and a stdout that is not a terminal are left to the pane.
func TestInlineImage(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Skip("no pty:", err)
	}
	defer master.Close()
	defer slave.Close()
	if err := pty.Setsize(slave, &pty.Winsize{Rows: 24, Cols: 30, X: 300, Y: 240}); err != nil {
		t.Fatal(err)
	}
	fd := int(slave.Fd())

	for name, enc := range map[string]func(*os.File, image.Image) error{
		"a.png": func(f *os.File, i image.Image) error { return png.Encode(f, i) },
		"a.jpg": func(f *os.File, i image.Image) error { return jpeg.Encode(f, i, nil) },
		"a.bmp": func(f *os.File, i image.Image) error { return bmp.Encode(f, i) },
		"noext": func(f *os.File, i image.Image) error { return png.Encode(f, i) },
	} {
		seq, ok := inlineImage(fd, writeImage(t, name, enc))
		if !ok {
			t.Errorf("%s: not inline", name)
			continue
		}
		// 300 px / 30 columns = 10 px a cell: 400 px is 40 cells, but the terminal has 30.
		if !strings.HasPrefix(string(seq), "\x1b_Ga=T,f=100,q=2,m=") || !strings.Contains(string(seq[:40]), ",c=30;") || !bytes.HasSuffix(seq, []byte("\x1b\\\n")) {
			t.Errorf("%s: %q", name, seq[:40])
		}
	}

	svg := filepath.Join(t.TempDir(), "a.svg")
	os.WriteFile(svg, []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 0o644)
	if _, ok := inlineImage(fd, svg); ok {
		t.Error("svg is inline")
	}
	if _, ok := inlineImage(fd, filepath.Join(t.TempDir(), "none.png")); ok {
		t.Error("a missing file is inline")
	}
	p := writeImage(t, "a.png", func(f *os.File, i image.Image) error { return png.Encode(f, i) })
	if _, ok := inlineImage(int(os.Stdin.Fd()), "/dev/null"); ok {
		t.Error("not an image is inline")
	}
	f, _ := os.Create(filepath.Join(t.TempDir(), "x"))
	defer f.Close()
	if _, ok := inlineImage(int(f.Fd()), p); ok {
		t.Error("a file as stdout is inline")
	}
}
