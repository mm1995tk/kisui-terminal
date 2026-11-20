package db

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// HistoryEntry is one statement the window ran (db.query). Its JSON form is
// one line of the history file and one entry of the result of the request
// db.history (docs/design/gui-protocol.md).
type HistoryEntry struct {
	// SQL is the statement as it was sent.
	SQL string `json:"sql"`
	// At is when the statement was sent, in UTC, to the millisecond.
	At time.Time `json:"at"`
	// OK is true when the database ran the statement without an error.
	OK bool `json:"ok"`
}

// The limits of the history of one connection. When a statement is added
// past them, the oldest ones are dropped.
const (
	// MaxHistoryEntries is the most statements kept.
	MaxHistoryEntries = 1000
	// maxHistoryBytes is the most bytes the file of one connection holds.
	maxHistoryBytes = 4 << 20
	// MaxHistorySQL is the longest statement kept, in bytes. A longer one (a
	// pasted dump, say) is not kept: it would push many others out, and a
	// statement cut short must not be run again.
	MaxHistorySQL = 64 << 10
)

// History keeps the statements run on each connection, in files in Dir, one
// file per connection, so that they outlive `kisui serve`. The statements of
// one connection are never shown for another (a statement for production
// must not turn up in the tab of a development database).
//
// A connection is told by its name (config.DBConnection.Name), the name the
// window asks with. Its file is the SHA-256 of the name in hexadecimal and
// ".jsonl": the name may hold any character, and a file system that ignores
// case must not put "Prod" and "prod" in one file.
//
// The file holds one HistoryEntry in JSON per line, oldest first. It is
// rewritten whole (in a temporary file that then replaces it), so it is
// never left half written.
type History struct {
	// Dir is the folder of the files. "" keeps nothing.
	Dir string

	mu sync.Mutex
}

// historyFile is the file of the connection name.
func (h *History) historyFile(name string) string {
	sum := sha256.Sum256([]byte(name))
	return filepath.Join(h.Dir, hex.EncodeToString(sum[:])+".jsonl")
}

// Add keeps e as the newest statement of the connection name. A statement
// longer than MaxHistorySQL is not kept (and is no error).
func (h *History) Add(name string, e HistoryEntry) error {
	if h == nil || h.Dir == "" || len(e.SQL) > MaxHistorySQL {
		return nil
	}
	e.At = e.At.UTC().Truncate(time.Millisecond)
	h.mu.Lock()
	defer h.mu.Unlock()
	path := h.historyFile(name)
	list, err := readHistory(path)
	if err != nil {
		return err
	}
	list = append(list, e)
	var lines [][]byte
	size := 0
	for i := len(list) - 1; i >= 0 && len(lines) < MaxHistoryEntries; i-- {
		line, err := json.Marshal(list[i])
		if err != nil {
			return err
		}
		if size+len(line)+1 > maxHistoryBytes {
			break
		}
		size += len(line) + 1
		lines = append(lines, line)
	}
	slices.Reverse(lines)
	var buf bytes.Buffer
	for _, l := range lines {
		buf.Write(l)
		buf.WriteByte('\n')
	}
	return writeAtomic(path, buf.Bytes())
}

// List gives the statements of the connection name, newest first: at most
// limit of them, or all when limit is 0 or less.
func (h *History) List(name string, limit int) ([]HistoryEntry, error) {
	out := []HistoryEntry{}
	if h == nil || h.Dir == "" {
		return out, nil
	}
	h.mu.Lock()
	list, err := readHistory(h.historyFile(name))
	h.mu.Unlock()
	if err != nil {
		return out, err
	}
	for i := len(list) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		out = append(out, list[i])
	}
	return out, nil
}

// readHistory reads a history file, oldest first. A missing file is an
// empty history. A line that is not an entry is skipped, so that one broken
// line does not lose the rest.
func readHistory(path string) ([]HistoryEntry, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var list []HistoryEntry
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(nil, maxHistoryBytes+1)
	for sc.Scan() {
		var e HistoryEntry
		if json.Unmarshal(sc.Bytes(), &e) != nil || e.SQL == "" {
			continue
		}
		list = append(list, e)
	}
	return list, sc.Err()
}

// writeAtomic writes data to path through a temporary file in the same
// folder, readable by the user only.
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".history-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}
