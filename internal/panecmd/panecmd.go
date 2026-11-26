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
//     an http or https URL (the GUI opens it in the browser of the machine it
//     runs on; no pane), or the absolute path of a file
//     (a video, image or PDF pane, by its kind).
//
//   - "split": split the terminal Pane in the direction Dir ("right", "down", "left" or "up") and
//     start a new terminal in it: its shell, or the command Argv (its first word is
//     an absolute path; the new terminal ends with the command) in Cwd. Env is
//     "NAME=value" entries for the new terminal. Name, when not empty, is the name
//     of the new terminal (the rules of "title").
//
//   - "title": give the terminal Pane the name Title (empty takes the name away).
//     A name is unique among the terminals of one "kisui serve" (one machine), and
//     is not written like an id ("t1"): a name that another terminal has, or that
//     looks like an id, is refused. So a name, or an id, points at one terminal of
//     the machine.
//
//   - "send": type Text in the terminal To (a name or an id of a terminal of this
//     "kisui serve", of any workspace) and press Enter. Text has no control
//     characters but newlines and tabs. When the program there turned on
//     bracketed paste, Text is sent as a paste. The focus does not move.
//
//   - "keys": press the Keys (such as "esc", "ctrl+c", "up") in the terminal To, in order.
//
//   - "close": close the terminal To. The primary terminal of a tab is refused
//     (it closes with its tab).
//
//   - "list": the terminals of this "kisui serve", of every workspace (Reply.Panes).
//
//   - "read": the text on the screen of the terminal To (a name or an id of a
//     terminal of this "kisui serve", of any workspace), with Lines lines of its
//     scrollback above it (Reply.Text). No colors or other attributes.
//
//   - "open-tab": add a terminal tab at the end of the workspace of the window
//     Workspace (its id, PaneInfo.Workspace, when Workspace is written like one,
//     "g" and ten letters or digits; otherwise its name; with New, a new
//     workspace of that name), and run its
//     shell, or the command Argv (the rules of "split"), in Cwd (empty: the
//     folder of the terminal that asks). Env is "NAME=value" entries for it. Name
//     (not empty) is the name of its terminal (the rules of "title"). The focus
//     does not move. The window owns its workspaces, so "kisui serve" asks the
//     window to make the tab and waits for its answer.
//
//   - "update": ask the window to look for a newer version of kisui-terminal now.
//     The window shows its "a new version is available" notice when there is one,
//     and answers (Reply.Update) for the command to print.
//
//   - "db-connections": the database connections in the settings of this "kisui
//     serve" (the machine of the terminal), with what a coding agent may do on
//     each (Reply.DB: the result of the request db.connections).
//
//   - "db-schema": the schemas, tables and columns of the connection Connection
//     (and its Variant, "" for a connection without variants) (Reply.DB: the
//     result of db.schema). It is allowed whatever the permission of the agent.
//
//   - "db-query": run the one statement SQL on the connection, as the coding
//     agent: its permission decides whether it runs, and whether it may write
//     (Reply.DB: the result of db.query, with at most MaxRows rows; 0 is the
//     default of "kisui serve"). It is ended when the command goes away.
//
//   - "db-propose": write SQL into the input of a database tab of the window, for
//     a person to read and run. Refused (CodeDenied) unless the permission of the
//     agent allows it. The window owns the tabs, so "kisui serve" asks the window
//     and waits for its answer: when the input already holds SQL, the window asks
//     the person first, and their "no" is CodeDeclined.
//
// The four "db-" requests are always the coding agent's (the actor "agent" of
// docs/design/gui-protocol.md), never the person's, and never carry a
// password: one that is found nowhere, or that the database refuses, is
// CodePasswordRequired. They do not take a Machine: the connections are the
// ones of this "kisui serve".
//
// Machine, when not empty, is the name of another machine for "list", "send",
// "keys", "close", "read" and "open-tab": a name of [[gui.machines]] of the
// window (the ssh destination of a machine without a name), or "local" for the
// PC the window runs on. "kisui serve" does not know the panes of other
// machines, so it asks the window, which is connected to every machine, to do
// the request there, and waits for its answer. "list" there has no Self.
// "open-tab" there starts in Cwd (an absolute path on that machine; empty: the
// start folder of that machine), and Argv[0] is an absolute path on that machine.
//
// The server tells a Request from the other lines on the socket (the ones of
// shj, docs/protocol.md) by Cmd.
type Request struct {
	Cmd    string   `json:"cmd"`
	Pane   string   `json:"pane"`
	Token  string   `json:"token"`
	Target string   `json:"target,omitempty"`
	Dir    string   `json:"dir,omitempty"`
	Argv   []string `json:"argv,omitempty"`
	Cwd    string   `json:"cwd,omitempty"`
	Env    []string `json:"env,omitempty"`
	Title  string   `json:"title,omitempty"`
	Name   string   `json:"name,omitempty"`
	To     string   `json:"to,omitempty"`
	Text   string   `json:"text,omitempty"`
	Keys   []string `json:"keys,omitempty"`
	Lines  int      `json:"lines,omitempty"`
	// Workspace and New are for "open-tab".
	Workspace string `json:"workspace,omitempty"`
	New       bool   `json:"new,omitempty"`
	// Connection, Variant, SQL and MaxRows are for the "db-" requests.
	Connection string `json:"connection,omitempty"`
	Variant    string `json:"variant,omitempty"`
	SQL        string `json:"sql,omitempty"`
	MaxRows    int    `json:"maxRows,omitempty"`
	// Machine is the machine to do the request on (empty: this one).
	Machine string `json:"machine,omitempty"`
}

// Reply answers a Request. ID is the pane that "open" (a file), "split" or "open-tab" made, or
// the one that "send", "keys", "close" or "read" found by its name or id. Code is
// CodeNotInPane when the id and the secret are not the ones of a terminal of
// that "kisui serve".
type Reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Code  string `json:"code,omitempty"`
	ID    string `json:"id,omitempty"`
	// Update is what the window found for "update".
	Update *UpdateResult `json:"update,omitempty"`
	// Panes is the answer to "list": the terminals of the machine, by workspace
	// (in the order they were made), the primary terminal of each first.
	Panes []PaneInfo `json:"panes,omitempty"`
	// Text is the answer to "read": the lines of the screen, each ending in a
	// newline. A line that the terminal wrapped is one line; spaces at the end of a
	// line and the empty lines at the bottom of the screen are dropped.
	Text string `json:"text,omitempty"`
	// DB is the answer to "db-connections", "db-schema" and "db-query": the
	// result of the request db.connections, db.schema or db.query, in the JSON
	// of docs/design/gui-protocol.md. "kisui db ... --json" prints it as it is.
	DB json.RawMessage `json:"db,omitempty"`
}

// PaneInfo is one terminal in the answer to "list". "kisui pane list --json"
// prints these as they are, so the names of the fields are what an agent reads.
//
// Tab is the workspace of "kisui serve" the terminal belongs to, which is one
// terminal tab in the window (a workspace of the window holds tabs, and "kisui
// serve" does not know those). TabName is the name of the tab: the one the user
// gave it, or else the name of its folder.
//
// Workspace and WorkspaceName are the id and the name (the one in the sidebar)
// of the workspace of the window that holds the tab. The window tells them to
// "kisui serve", which remembers what it was told last (also while the window
// is closed, and after "kisui serve" starts again). They are empty when no
// window told them yet. "kisui pane open --workspace" takes either.
type PaneInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name,omitempty"`
	Workspace     string `json:"workspace,omitempty"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	Tab           string `json:"tab"`
	TabName       string `json:"tabName,omitempty"`
	Cwd           string `json:"cwd"`
	// Title is what the program in the terminal set as its title (OSC 0/2),
	// which often tells what runs there. It is not the name.
	Title string `json:"title,omitempty"`
	// Primary is the primary terminal of the tab: closing it closes the tab.
	Primary bool `json:"primary"`
	// Alive is false when the shell (or the command) of the terminal has ended.
	Alive bool `json:"alive"`
	// Self is the terminal that asked.
	Self bool `json:"self,omitempty"`
}

// The Status of an UpdateResult.
const (
	// UpdateAvailable: there is a newer version (Version); the window shows its notice.
	UpdateAvailable = "available"
	// UpdateLatest: this is the newest version.
	UpdateLatest = "latest"
	// UpdateManual: this build has no auto update (the Nix build, or Linux other than the AppImage).
	UpdateManual = "manual"
	// UpdateFailed: the check did not finish (Error says why; often no network).
	UpdateFailed = "failed"
)

// UpdateResult is the answer of the window to "update". Current is the version
// that runs and Version the newer one (only for UpdateAvailable).
type UpdateResult struct {
	Status  string `json:"status"`
	Current string `json:"current,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

// The values of Reply.Code, for the failures a command tells apart.
const (
	// CodeNotInPane: the server does not know the pane.
	CodeNotInPane = "not-in-pane"
	// CodeDenied: the permission of the coding agent does not allow it ("db-query", "db-propose").
	CodeDenied = "denied"
	// CodeDeclined: the person at the window said no ("db-propose").
	CodeDeclined = "declined"
	// CodePasswordRequired: the password of the connection is found nowhere
	// "kisui serve" looks, or the database refused the one it found or
	// remembers.
	CodePasswordRequired = "password-required"
	// CodeNotFound: the settings have no such connection (or variant).
	CodeNotFound = "not-found"
)

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

// Do sends rq (with the pane's id and secret) and reads the reply, waiting up
// to Timeout. A reply that is not OK is returned as an error with its text
// (ErrNotInPane for CodeNotInPane), beside the reply (for its Code).
func (p Pane) Do(rq Request) (Reply, error) {
	return p.DoWithin(rq, Timeout)
}

// DoWithin is Do that waits up to wait for the reply, and without a limit when
// wait is 0: for a request that takes as long as what it asks for (a
// statement of a database, the answer of a person). Ending the command closes
// the socket, which tells "kisui serve" to stop what it was doing for it.
func (p Pane) DoWithin(rq Request, wait time.Duration) (Reply, error) {
	rq.Pane, rq.Token = p.ID, p.Token
	c, err := net.DialTimeout("unix", p.Socket, Timeout)
	if err != nil {
		return Reply{}, noServerError{err}
	}
	defer c.Close()
	if wait > 0 {
		_ = c.SetDeadline(time.Now().Add(wait))
	}
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
