package kittyterm

import (
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// TTY is the terminal the command runs in (/dev/tty). It is not stdin nor
// stdout, so "echo x | kisui clipboard copy" and "kisui clipboard paste > f"
// still talk to the terminal.
type TTY struct {
	fd int
}

// OpenTTY opens the terminal of the process.
func OpenTTY() (*TTY, error) {
	fd, err := unix.Open("/dev/tty", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return &TTY{fd: fd}, nil
}

// Close closes the terminal.
func (t *TTY) Close() error { return unix.Close(t.fd) }

// Write writes all of b.
func (t *TTY) Write(b []byte) error {
	for len(b) > 0 {
		n, err := unix.Write(t.fd, b)
		if errors.Is(err, unix.EINTR) || errors.Is(err, unix.EAGAIN) {
			continue
		}
		if err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

// ReadsKeys reports whether the terminal hands over the keys one by one
// (ICANON is off) instead of waiting for a line. Then a full-screen program
// (an editor such as shj) reads the terminal. A shell puts the terminal back
// to lines before it runs a command, so a command the user runs from the
// shell sees false.
func (t *TTY) ReadsKeys() (bool, error) {
	tio, err := unix.IoctlGetTermios(t.fd, ioctlGetTermios)
	if err != nil {
		return false, err
	}
	return tio.Lflag&unix.ICANON == 0, nil
}

// AskUnlessKeys is Ask, except while a full-screen program reads the terminal
// (ReadsKeys, or when that cannot be told): then it only writes req, and does
// not change the terminal nor read it. Ask would read the terminal at the same
// time as the program and take its keys. Ask also changes the terminal so that
// a read returns at once with nothing, and the program can take that as the end
// of its input and stop reading keys. The answer goes to the program instead,
// which drops it when it parses it as an unknown OSC (shj does).
func (t *TTY) AskUnlessKeys(req []byte, timeout time.Duration, handle func(Packet) (bool, error)) error {
	if keys, err := t.ReadsKeys(); err != nil || keys {
		return t.Write(req)
	}
	return t.Ask(req, timeout, handle)
}

// ErrTimeout is returned by Ask when the terminal did not answer in time: it is
// not one that speaks the protocol (kisui-terminal does).
var ErrTimeout = errors.New("the terminal did not answer")

// ErrInterrupted is returned by Ask when the user stopped the command (Ctrl+C).
var ErrInterrupted = errors.New("interrupted")

// poll is how long one read waits (VTIME), so that Ask sees the time out and
// Ctrl+C while it waits.
const poll = 100 * time.Millisecond

// Ask writes req and reads what the terminal sends until handle says the
// answer is done (and returns its error), the timeout passes (ErrTimeout) or
// the user presses Ctrl+C (ErrInterrupted). Meanwhile the terminal does not
// echo nor wait for a line (the answer is not shown, nor sent to the shell),
// and it is put back as it was before Ask returns.
func (t *TTY) Ask(req []byte, timeout time.Duration, handle func(Packet) (bool, error)) error {
	old, err := unix.IoctlGetTermios(t.fd, ioctlGetTermios)
	if err != nil {
		return err
	}
	raw := *old
	raw.Lflag &^= unix.ICANON | unix.ECHO // keeps ISIG: Ctrl+C still sends SIGINT
	raw.Cc[unix.VMIN] = 0
	raw.Cc[unix.VTIME] = uint8(poll / (100 * time.Millisecond))
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sig)
	if err := unix.IoctlSetTermios(t.fd, ioctlSetTermios, &raw); err != nil {
		return err
	}
	defer func() { _ = unix.IoctlSetTermios(t.fd, ioctlSetTermios, old) }()
	if err := t.Write(req); err != nil {
		return err
	}
	var sc Scanner
	buf := make([]byte, 8192)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-sig:
			return ErrInterrupted
		default:
		}
		n, err := unix.Read(t.fd, buf)
		if errors.Is(err, unix.EINTR) || errors.Is(err, unix.EAGAIN) {
			continue
		}
		if err != nil {
			return err
		}
		for _, p := range sc.Feed(buf[:n]) {
			if done, err := handle(p); done {
				return err
			}
		}
	}
	return ErrTimeout
}
