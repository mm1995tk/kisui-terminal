// Package attach は「kisui attach」の中身。ssh の先で動く小さな橋渡しで、
// 標準入出力と kisui serve の Unix ソケットをバイトのままつなぐ。
// 設計は docs/design/gui-protocol.md の「ssh 越しに shj を起動する」。
package attach

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Marker は始まりの目印。ログインシェルが motd などを出しても、GUI はこの行より前を捨てる。
const Marker = "@@shj-rpc 1@@\n"

// Info は attach.info 通知の中身。目印のすぐあとに 1 行で出し、GUI に、この attach がどの kisui かを伝える。
// GUI は serve の版（session.hello の shj）とこれを比べ、違えば Executable と Env で server.handover を頼む
// （docs/design/gui-protocol.md の「ssh 越しに kisui を起動する」の 5）。
type Info struct {
	// Executable はこの kisui の実行ファイルの絶対パス（引き継ぎで新しい serve に使う）。
	Executable string `json:"executable"`
	// Version・Commit・Channel は、session.hello の shj と同じ形の、この kisui の版。
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Channel string `json:"channel"`
	// Env は新しい serve に渡す環境変数（server.handover の env）。無ければ省く。
	Env map[string]string `json:"env,omitempty"`
}

// Options は Run に渡すもの。
type Options struct {
	SocketPath string
	LockPath   string
	// Info があれば、目印のすぐあと（serve の出力より前）に attach.info 通知として出す。
	Info *Info
	// Start は kisui serve を切り離して起動する。待たずに返ってよい。
	Start func() error
	// Exited は、Start で起こした kisui serve が待つ間に終わったかを返す。終わっていたら
	// その理由（標準エラー出力の中身など）を返す。無ければ nil でよい。設定の間違いなどで
	// serve が起動できないとき、待ちきる前にその理由を attach の標準エラー出力へ届けるために使う。
	Exited func() (reason string, exited bool)
	// WaitTimeout はソケットができるのを待つ最長時間。0 なら 5 秒。
	WaitTimeout time.Duration
	// Poll は待つ間隔。0 なら 50 ミリ秒。
	Poll time.Duration
	In   io.Reader
	Out  io.Writer
}

func (o *Options) defaults() {
	if o.WaitTimeout == 0 {
		o.WaitTimeout = 5 * time.Second
	}
	if o.Poll == 0 {
		o.Poll = 50 * time.Millisecond
	}
}

// Run は目印を出し、動いている kisui serve につなぎ（無ければ起動し）、
// どちらかが閉じるまで In/Out とソケットの間をコピーする。
func Run(o Options) error {
	o.defaults()
	head := []byte(Marker)
	if o.Info != nil {
		line, err := infoLine(*o.Info)
		if err != nil {
			return err
		}
		head = append(head, line...)
	}
	if _, err := o.Out.Write(head); err != nil {
		return err
	}
	conn, err := connect(o)
	if err != nil {
		return err
	}
	defer conn.Close()
	return bridge(conn, o.In, o.Out)
}

// infoLine は attach.info 通知の 1 行（末尾の改行付き）。
func infoLine(info Info) ([]byte, error) {
	b, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "attach.info", "params": info})
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func connect(o Options) (net.Conn, error) {
	if c, err := net.Dial("unix", o.SocketPath); err == nil {
		return c, nil
	}
	// 動いていない。同時に起動した相手と 1 つにするため、ロックを取って起動する。
	unlock, err := lock(o.LockPath, o.WaitTimeout, o.Poll)
	if err != nil {
		return nil, err
	}
	defer unlock()
	// ロックを待つ間に相手が起動したかもしれない。
	if c, err := net.Dial("unix", o.SocketPath); err == nil {
		return c, nil
	}
	if err := o.Start(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(o.WaitTimeout)
	for {
		c, err := net.Dial("unix", o.SocketPath)
		if err == nil {
			return c, nil
		}
		if o.Exited != nil {
			if reason, exited := o.Exited(); exited {
				// 終わる間際に socket ができていたかもしれない。
				if c, err := net.Dial("unix", o.SocketPath); err == nil {
					return c, nil
				}
				return nil, &StartError{Reason: reason}
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("kisui serve did not start within %s: %w", o.WaitTimeout, err)
		}
		time.Sleep(o.Poll)
	}
}

// StartError は kisui serve が起動できずに終わったときのエラー。Reason はその標準エラー出力。
type StartError struct{ Reason string }

func (e *StartError) Error() string { return e.Reason }

// lock は path に flock(LOCK_EX) をかける。timeout の間だけ待つ。
func lock(path string, timeout, poll time.Duration) (func(), error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { f.Close() }, nil // 閉じるとロックも外れる
		}
		if !errors.Is(err, unix.EWOULDBLOCK) || time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("lock %s: %w", path, err)
		}
		time.Sleep(poll)
	}
}

// bridge はバイトのままコピーし、どちらかが終わったら返る。
func bridge(conn net.Conn, in io.Reader, out io.Writer) error {
	done := make(chan error, 2)
	go func() { _, err := io.Copy(conn, in); done <- err }()
	go func() { _, err := io.Copy(out, conn); done <- err }()
	return <-done
}
