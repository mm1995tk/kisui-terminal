package db

import (
	"context"
	"sync"
	"time"
)

// How long each step of stopping a statement may take. Variables so that the
// tests need not wait.
var (
	// softTimeout is how long asking the database to stop may take.
	softTimeout = 5 * time.Second
	// stopGrace is how long the statement may take to end after the database
	// was asked to stop it.
	stopGrace = 5 * time.Second
)

// stopper stops the statement a session is running, in two steps: soft asks
// the database to stop the statement (the session stays usable, and the
// database really stops working on it); hard, when that did not help, closes
// the connection under the statement so that reading its result returns.
//
// A statement is not run with the caller's context for this reason: the
// drivers would only close the connection, and the database could go on with
// a long UPDATE that nobody waits for.
type stopper struct {
	stopCh   chan struct{}
	doneCh   chan struct{}
	finished chan struct{}
	once     sync.Once
	asked    bool // soft was called; read after finished is closed
}

// watch starts watching: the statement is stopped when ctx ends or stop is
// called. The caller must call end when the statement has ended.
func watch(ctx context.Context, soft func(context.Context) error, hard func()) *stopper {
	s := &stopper{stopCh: make(chan struct{}), doneCh: make(chan struct{}), finished: make(chan struct{})}
	go func() {
		defer close(s.finished)
		select {
		case <-ctx.Done():
		case <-s.stopCh:
		case <-s.doneCh:
			return
		}
		// Asking is not given up when the statement ends by itself meanwhile:
		// then nobody would know whether the database was asked.
		sctx, cancel := context.WithTimeout(context.Background(), softTimeout)
		s.asked = true
		err := soft(sctx)
		cancel()
		select {
		case <-s.doneCh:
			return
		default:
		}
		if err != nil {
			hard()
			return
		}
		select {
		case <-s.doneCh:
		case <-time.After(stopGrace):
			hard()
		}
	}()
	return s
}

// stop stops the statement now, as if the context had ended.
func (s *stopper) stop() { s.once.Do(func() { close(s.stopCh) }) }

// end tells that the statement has ended, and waits until nothing is being
// done to stop it any more. asked is true when the database was asked to stop
// the statement. The request may have reached it after the statement ended by
// itself, and then it stops the next statement of the session instead: the
// caller runs a statement that may fail before going on.
func (s *stopper) end() (asked bool) {
	close(s.doneCh)
	<-s.finished
	return s.asked
}
