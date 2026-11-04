package server

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo"
)

// DefaultMaxLog はログファイルの大きさの上限（10 MiB）。
const DefaultMaxLog = 10 << 20

// LogPath は serve.log の場所を返す。$XDG_STATE_HOME/shijimi-editor/serve.log、
// 無ければ ~/.local/state/shijimi-editor/serve.log。nightly は shijimi-editor-nightly。
func LogPath() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "serve.log"), nil
}

// stateDir は serve.log とワークスペースの一覧を置くフォルダ。
func stateDir() (string, error) {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "shijimi-editor"+buildinfo.Suffix()), nil
}

// logFile は上限を超えたら先頭を捨てる追記専用のログファイル。
type logFile struct {
	mu   sync.Mutex
	f    *os.File
	size int64
	max  int64
}

// OpenLog はログファイルを開く（無ければ作る）。開いた時点で上限を超えていれば先頭を捨てる。
// max が 0 以下なら DefaultMaxLog。
func OpenLog(path string, max int64) (io.WriteCloser, error) {
	if max <= 0 {
		max = DefaultMaxLog
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	l := &logFile{f: f, size: st.Size(), max: max}
	if l.size > l.max {
		if err := l.trim(); err != nil {
			f.Close()
			return nil, err
		}
	}
	return l, nil
}

func (l *logFile) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size+int64(len(p)) > l.max {
		if err := l.trim(); err != nil {
			return 0, err
		}
	}
	n, err := l.f.WriteAt(p, l.size)
	l.size += int64(n)
	return n, err
}

func (l *logFile) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}

// trim は先頭を捨てて、末尾の半分（max/2）ほどを、行の頭から残す。
func (l *logFile) trim() error {
	keep := min(l.max/2, l.size)
	buf := make([]byte, keep)
	n, err := l.f.ReadAt(buf, l.size-keep)
	if err != nil && err != io.EOF {
		return err
	}
	buf = buf[:n]
	// 途中から始まる行は捨てる（切り出しが行の頭ちょうどなら捨てない）。
	if keep < l.size {
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		} else {
			buf = buf[:0] // 1 行が長すぎる。全部捨てる
		}
	}
	if err := l.f.Truncate(0); err != nil {
		return err
	}
	if _, err := l.f.WriteAt(buf, 0); err != nil {
		return err
	}
	l.size = int64(len(buf))
	return nil
}
