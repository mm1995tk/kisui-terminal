package server

import (
	"path/filepath"
	"strings"
)

// fileKind is a kind of pane that shows one file (video, image, pdf). To add a
// kind, add one entry to fileKinds, the kind to ExtraPane in app/src/rpc/protocol.ts
// and a view in app/src/terminal (see docs/design/gui-protocol.md).
type fileKind struct {
	// mime maps a lower-case extension (with the dot) to the media type.
	mime map[string]string
	// maxSize is the largest file the pane opens, in bytes (0: no limit here;
	// the GUI has its own limit, MAX_BYTES in app/src/terminal/media.ts: keep them equal).
	maxSize int64
}

// fileKinds are the kinds of panes that show a file, by Kind of a PaneRequest.
// The video list is the same as shj's (core/video.go in shijimi-editor): the
// videos shj asks kisui to play are the ones kisui's web view can show.
var fileKinds = map[string]fileKind{
	"video": {mime: map[string]string{
		".mp4":  "video/mp4",
		".m4v":  "video/mp4",
		".mov":  "video/quicktime",
		".webm": "video/webm",
		".ogv":  "video/ogg",
		".mkv":  "video/x-matroska",
	}},
	"image": {maxSize: 64 << 20, mime: map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".webp": "image/webp",
		".avif": "image/avif",
		".bmp":  "image/bmp",
		".svg":  "image/svg+xml",
	}},
	"pdf": {maxSize: 128 << 20, mime: map[string]string{
		".pdf": "application/pdf",
	}},
}

// fileMIME is the media type of the file at path for the kind ("" when the
// extension is not one of the kind's).
func fileMIME(kind, path string) string {
	return fileKinds[kind].mime[strings.ToLower(filepath.Ext(path))]
}
