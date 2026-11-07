// Package panecmd is how the kisui commands that run in a pane ("kisui open"
// and the ones to come) talk to the "kisui serve" that runs the pane. It is
// kisui's own: shj does not use it, and it is not part of docs/protocol.md.
//
// "kisui serve" gives every terminal it starts three environment variables:
// the socket to talk to (EnvSocket), the id of the terminal (EnvPane) and a
// random secret of that terminal (EnvToken). A command sends one Request (one
// line of JSON) with the id and the secret on the socket and reads one Reply.
// The socket is in the private (0700) socket directory, so other users cannot
// reach it, and a process of the same user that was not started in a pane does
// not know a secret.
package panecmd

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"time"
)

// The environment variables "kisui serve" sets in every terminal it starts.
const (
	// EnvSocket is the socket of "kisui serve" that takes the requests (serve-primary.rpc).
	EnvSocket = "KISUI_SOCKET"
	// EnvPane is the id of the terminal.
	EnvPane = "KISUI_PANE"
	// EnvToken is the secret of the terminal.
	EnvToken = "KISUI_PANE_TOKEN"
)

// Request is the one line a command sends. Cmd is what it asks for:
//
//   - "open": show Target in a pane of the workspace of the terminal. Target is
//     an http or https URL (a browser pane), or the absolute path of a file
//     (a video, image or PDF pane, by its kind).
//
// The server tells a Request from the other lines on the socket (the ones of
// shj, docs/protocol.md) by Cmd.
type Request struct {
	Cmd    string `json:"cmd"`
	Pane   string `json:"pane"`
	Token  string `json:"token"`
	Target string `json:"target,omitempty"`
}

// Reply answers a Request. ID is the pane that "open" showed. Code is
// CodeNotInPane when the id and the secret are not the ones of a terminal of
// that "kisui serve".
type Reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Code  string `json:"code,omitempty"`
	ID    string `json:"id,omitempty"`
}

// CodeNotInPane is Reply.Code when the server does not know the pane.
const CodeNotInPane = "not-in-pane"

// ErrNotInPane is returned by FromEnv when the variables are not set, and by
// Do when the server does not know the pane: the command does not run in a
// pane of kisui-terminal.
var ErrNotInPane = errors.New("not in a pane of kisui-terminal")

// ErrNoServer is what the error of Do is (errors.Is) when the socket does not
// answer: "kisui serve" has ended. The text of that error is the one of the
// dial, so that a message that says "not running" does not say it twice.
var ErrNoServer = errors.New("kisui serve is not running")

type noServerError struct{ err error }

func (e noServerError) Error() string        { return e.err.Error() }
func (e noServerError) Unwrap() error        { return e.err }
func (e noServerError) Is(target error) bool { return target == ErrNoServer }

// Pane is where a command runs: the socket, the terminal and its secret.
type Pane struct {
	Socket, ID, Token string
}

// FromEnv reads the variables. It returns ErrNotInPane when one is missing.
func FromEnv() (Pane, error) {
	p := Pane{Socket: os.Getenv(EnvSocket), ID: os.Getenv(EnvPane), Token: os.Getenv(EnvToken)}
	if p.Socket == "" || p.ID == "" || p.Token == "" {
		return Pane{}, ErrNotInPane
	}
	return p, nil
}

// Timeout is how long Do waits for "kisui serve".
const Timeout = 10 * time.Second

// Do sends rq (with the pane's id and secret) and reads the reply. A reply that
// is not OK is returned as an error with its text (ErrNotInPane for
// CodeNotInPane).
func (p Pane) Do(rq Request) (Reply, error) {
	rq.Pane, rq.Token = p.ID, p.Token
	c, err := net.DialTimeout("unix", p.Socket, Timeout)
	if err != nil {
		return Reply{}, noServerError{err}
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(Timeout))
	b, err := json.Marshal(rq)
	if err != nil {
		return Reply{}, err
	}
	if _, err := c.Write(append(b, '\n')); err != nil {
		return Reply{}, err
	}
	var r Reply
	if err := json.NewDecoder(c).Decode(&r); err != nil {
		return Reply{}, err
	}
	switch {
	case r.OK:
		return r, nil
	case r.Code == CodeNotInPane:
		return r, ErrNotInPane
	}
	return r, errors.New(r.Error)
}

// HasScheme reports whether target is written as a URL ("<scheme>://..."), not
// as a file path. "kisui open" sends a URL as it is and makes a path absolute.
func HasScheme(target string) bool {
	scheme, _, ok := strings.Cut(target, "://")
	return ok && scheme != "" && !strings.ContainsAny(scheme, `/\.`)
}
