package server

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// shutdownGrace is how long server.shutdown waits before it stops the server,
// so the reply reaches the GUI first.
const shutdownGrace = 200 * time.Millisecond

// defaultIdleCheck is how often the server looks at the idle time.
const defaultIdleCheck = time.Minute

func (s *Server) now() time.Time {
	if s.opts.Now != nil {
		return s.opts.Now()
	}
	return time.Now()
}

// AddBeforeStop registers fn to run once just before the server stops for
// being idle or for server.shutdown (not for a signal or Close). Workspaces use
// it to write their unsaved edits with WriteBackup.
func (s *Server) AddBeforeStop(fn func()) {
	s.mu.Lock()
	s.beforeStop = append(s.beforeStop, fn)
	s.mu.Unlock()
}

// stop runs the before-stop hooks once and then makes Serve return.
func (s *Server) stop(reason string) {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return
	}
	s.stopping = true
	hooks := s.beforeStop
	s.mu.Unlock()
	s.log.Info("stopping", "reason", reason)
	for _, fn := range hooks {
		fn()
	}
	s.ln.Close()
}

// baseOfIdle is when the idle time counts from: the last time a GUI was
// connected, or the start of the server if none ever was.
func (s *Server) baseOfIdle() time.Time {
	if s.lastClient.IsZero() {
		return s.startedAt
	}
	return s.lastClient
}

// idleStopAt is when the server stops for being idle. nil when a GUI is
// connected or the setting is 0.
func (s *Server) idleStopAt() *time.Time {
	if s.opts.IdleStop <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) > 0 {
		return nil
	}
	t := s.baseOfIdle().Add(s.opts.IdleStop)
	return &t
}

// watchIdle stops the server once no GUI has been connected for IdleStop.
// It returns when done is closed.
func (s *Server) watchIdle(done <-chan struct{}) {
	if s.opts.IdleStop <= 0 {
		return
	}
	every := s.opts.IdleCheck
	if every <= 0 {
		every = defaultIdleCheck
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			if at := s.idleStopAt(); at != nil && !s.now().Before(*at) {
				s.stop("idle")
				return
			}
		}
	}
}

// shutdownReq is server.shutdown.
func (s *Server) shutdownReq(req *rpc.Message) (any, error) {
	var p struct {
		Force bool `json:"force"`
	}
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params: %v", err)
		}
	}
	n := s.terms.count()
	if n > 0 && !p.Force {
		return nil, rpc.Errorf(rpc.CodeBusy, "%d terminals are running; send force to stop anyway", n)
	}
	time.AfterFunc(shutdownGrace, func() { s.stop("server.shutdown") })
	return map[string]int{"terminals": n}, nil
}

// WriteBackup writes data next to path as <path>.bk, or <path>.bk.1, .bk.2, ...
// if the name is taken. It never overwrites a file, and never touches path. It
// returns the path it wrote.
func WriteBackup(path string, data []byte) (string, error) {
	perm := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}
	for i := 0; ; i++ {
		name := path + ".bk"
		if i > 0 {
			name = fmt.Sprintf("%s.bk.%d", path, i)
		}
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, err := f.Write(data); err != nil {
			f.Close()
			return "", err
		}
		return name, f.Close()
	}
}
