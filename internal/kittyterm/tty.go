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
