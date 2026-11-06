package server

import (
	"path/filepath"
	"strings"
)

// videoMIME is the media type of a video file, by its extension. The same
// list as shj's (core/video.go in shijimi-editor): the videos shj asks kisui
// to play are the ones kisui's web view can show.
var videoMIME = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".ogv":  "video/ogg",
	".mkv":  "video/x-matroska",
}

// isVideo reports whether path is a video file, by its extension.
func isVideo(path string) bool { return VideoMIME(path) != "" }

// VideoMIME is the media type of the video at path ("" when it is not a video).
func VideoMIME(path string) string {
	return videoMIME[strings.ToLower(filepath.Ext(path))]
}
