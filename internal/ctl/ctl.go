// Package ctl is what kisui promises the shj in its panes, and what it needs
// of the control socket of that shj: the messages (newline-delimited JSON),
// the names of the environment variables and where the sockets live. It is
// the kisui side of the agreement in docs/protocol.md; shj keeps its own copy
// of the same types (core/ctl in shijimi-editor). Nothing is imported across.
package ctl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// EnvSocket is the environment variable that carries the socket path.
const EnvSocket = "SHIJIMI_SOCKET"

// EnvGUIPrimary is set by "kisui serve" in every terminal of a GUI
// workspace, and its value is that terminal's id (so a split terminal that is
// later promoted to the primary can announce too; serve checks that the terminal
// is the primary when it is announced). A TUI shj that finds it
// announces itself on the primary socket (see PrimaryHello), then removes it
// from its own environment so that nothing it starts can claim the primary.
const EnvGUIPrimary = "SHIJIMI_GUI_PRIMARY"

// EnvGUIWorkspace is set by "kisui serve" in every terminal of a GUI workspace;
// its value is the workspace id. The shj subcommands use it to reach the shj
// that runs in that workspace's primary terminal (GUILinkPath), even when it
// was started after the terminal. A terminal's environment cannot change after
// it starts, so the variable names the workspace and the link says where the
// shj is now.
const EnvGUIWorkspace = "SHIJIMI_GUI_WORKSPACE"

// The herdr terminal multiplexer sets these in the panes it runs. The editor
// uses them to publish its socket under a name that shj can build from the
// same variables when SHIJIMI_SOCKET is not passed along (herdr's key bound
// shell commands, for example).
const (
	EnvHerdr          = "HERDR_ENV"
	EnvHerdrWorkspace = "HERDR_WORKSPACE_ID"
	EnvHerdrPane      = "HERDR_PANE_ID"
)

// Request is sent by the CLI to the editor.
type Request struct {
	Cmd  string `json:"cmd"`            // diff | exec | command-end | open | changes-key
	Path string `json:"path,omitempty"` // diff, open: an absolute path (diff: also the Path of a DiffFile, which may be deleted)
	Line string `json:"line,omitempty"` // exec: the ":" command to run; command-end: the exit code; changes-key: the key ("s", "r", "R", "space" or ":")
}

// Response is the editor's reply.
type Response struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"` // exec: the status line after the command
}

// SocketDir returns the private (0700) directory that holds the sockets of
// this user's editors: $XDG_RUNTIME_DIR/shijimi<suffix>-<uid>. The build says
// the suffix: "-nightly" for a nightly build, so that shj and shj-nightly do
// not touch each other's sockets, and "" for the stable one. Without
// XDG_RUNTIME_DIR it is under the temporary directory. With create, the
// directory is made and its mode is enforced.
func SocketDir(suffix string, create bool) (string, error) {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, fmt.Sprintf("shijimi%s-%d", suffix, os.Getuid()))
	if !create {
		return dir, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// SocketPath returns a fresh socket path inside the socket directory:
// <SocketDir>/<pid>.sock. shj lists this directory to find a running editor
// when SHIJIMI_SOCKET is not set, so the directory holds nothing else but the
// per-workspace directories of the herdr links.
func SocketPath(suffix string) (string, error) {
	dir, err := SocketDir(suffix, true)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, fmt.Sprintf("%d.sock", os.Getpid())), nil
}

// ServeSocketPath returns the socket of "kisui serve": <SocketDir>/serve.rpc.
// The name does not end in ".sock" on purpose: ctlclient.FindSocket treats
// every "*.sock" in the directory as an editor and would count the server as
// one.
func ServeSocketPath(suffix string) (string, error) {
	dir, err := SocketDir(suffix, true)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "serve.rpc"), nil
}

// ServeLockPath returns the lock file that "kisui attach" takes with flock while
// it starts "kisui serve": <SocketDir>/serve.lock.
func ServeLockPath(suffix string) (string, error) {
	dir, err := SocketDir(suffix, true)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "serve.lock"), nil
}

// HerdrDir is the directory of the links of the editors of one herdr workspace.
func HerdrDir(dir, ws string) string {
	return filepath.Join(dir, "herdr-"+SafeName(ws))
}

// GUILinkPath is where "kisui serve" links the socket of the shj in the primary
// terminal of GUI workspace ws: <dir>/gui-<ws>/primary.sock, a symbolic link to
// <pid>.sock. It lives in a directory of its own so that FindSocket's search
// of dir for "*.sock" does not count it twice.
func GUILinkPath(dir, ws string) string {
	return filepath.Join(dir, "gui-"+SafeName(ws), "primary.sock")
}

// SafeName makes a herdr id usable as a file name: anything but letters,
// digits, ".", "_" and "-" becomes "_".
func SafeName(id string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		}
		return '_'
	}, id)
}

// ServePrimaryName is the file name of the primary socket of "kisui serve",
// <SocketDir>/serve-primary.rpc, on which a TUI shj announces that it runs in
// the primary terminal of a workspace. Like serve.rpc it does not end in
// ".sock".
const ServePrimaryName = "serve-primary.rpc"

// ServePrimarySocketPath returns the path of that socket.
func ServePrimarySocketPath(suffix string) (string, error) {
	dir, err := SocketDir(suffix, true)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, ServePrimaryName), nil
}

// PrimaryProtocol is the version of the shj -> kisui protocol (PrimaryHello,
// PrimaryFile, PrimaryReply, PaneRequest, PaneReply, the variables and the
// socket) that this shj speaks. kisui-terminal owns the protocol; see
// docs/protocol.md for when the number goes up. A shj from
// before the number existed sends none, which is version 0.
const PrimaryProtocol = 1

// ReplyCodeVersion is PrimaryReply.Code when the shj's protocol version is
// outside the range that "kisui serve" accepts.
const ReplyCodeVersion = "version"

// PrimaryHello is the one line (newline-delimited JSON) a shj sends on the
// primary socket. TermID is the value of EnvGUIPrimary, Socket is the shj's
// own control socket and PID its process id. Protocol is the version of the
// protocol the shj speaks (PrimaryProtocol); absent means 0.
type PrimaryHello struct {
	TermID   string `json:"termId"`
	Socket   string `json:"socket"`
	PID      int    `json:"pid"`
	Protocol int    `json:"protocol,omitempty"`
}

// PrimaryFile is a line the shj sends on the primary socket after the reply
// said OK, each time the file it shows or its diff mode changes (and once at
// the start): File is the absolute path of the file of the focused tab (a text
// or an image, also while a diff or a preview of it is shown), or "" when there
// is no tab (the welcome page). Every line is the whole state, not a change.
//
// Diff is present while the shj is in diff mode against HEAD (Ctrl+G) and
// absent otherwise: its presence is the beginning of the diff mode and its
// absence the end. The diff mode against a pull request (Space g) is reported
// too, with PrimaryDiff.Base "pr", but only to a kisui that answered with
// PrimaryReply.ChangesPR; to any other the shj shows its own list there,
// because an older kisui's "diff" request would switch it to HEAD. An older
// kisui ignores Diff.
type PrimaryFile struct {
	File string       `json:"file"`
	Diff *PrimaryDiff `json:"diff,omitempty"`
}

// PrimaryDiff is the list of changes (CHANGES) of the diff mode of a shj that
// runs in the primary terminal of a GUI workspace. kisui shows it in the
// sidebar under the file explorer, and the shj shows no list of its own.
// Files are in the order the shj shows them. Selected is the absolute path of
// the file whose diff the shj shows now, or "" when none is shown. Base says
// what the diff compares with: BaseHead ("head", also when empty) or BasePR
// ("pr", the pull request of the branch; Space g).
type PrimaryDiff struct {
	Files    []DiffFile `json:"files"`
	Selected string     `json:"selected,omitempty"`
	Base     string     `json:"base,omitempty"`
}

// Values of PrimaryDiff.Base. Any other value is taken as BaseHead.
const (
	BaseHead = "head"
	BasePR   = "pr"
)

// DiffFile is a changed file of PrimaryDiff. Path is absolute (a deleted file
// has no file on disk but a path all the same). Status is one of "modified",
// "added", "deleted", "renamed" and "binary"; kisui takes any other value (or
// none) as "modified". Added and Deleted are numbers of lines (0 for a binary
// file).
type DiffFile struct {
	Path    string `json:"path"`
	Status  string `json:"status,omitempty"`
	Added   int    `json:"added,omitempty"`
	Deleted int    `json:"deleted,omitempty"`
}

// PrimaryReply answers a PrimaryHello with one line. When OK, the connection
// stays open for as long as the shj runs, and "kisui serve" takes its close as
// the end of the shj. When not OK (the primary already has a shj, the terminal
// is not a primary one) the server closes the connection. Code is
// ReplyCodeVersion when the version is the reason; Min and Max are then the
// versions "kisui serve" accepts. Changes is true when OK and this kisui shows
// the CHANGES of the shj's diff mode in its sidebar (PrimaryFile.Diff); a
// reply without it is from a kisui that does not, and the shj then shows its
// own list. ChangesPR is true when OK and this kisui also shows the CHANGES of
// the diff mode against a pull request (PrimaryDiff.Base "pr") and keeps the
// shj in that mode when a file is opened from it; the shj sends the list of
// that mode only then.
type PrimaryReply struct {
	OK        bool   `json:"ok"`
	Changes   bool   `json:"changes,omitempty"`
	ChangesPR bool   `json:"changesPR,omitempty"`
	Error     string `json:"error,omitempty"`
	Code      string `json:"code,omitempty"`
	Min       int    `json:"min,omitempty"`
	Max       int    `json:"max,omitempty"`
}

// PaneRequest is the one line a shj that runs in the primary terminal of a GUI
// workspace sends on the primary socket (a connection of its own, apart from
// the one that announced it) to use the GUI's panes for its terminal commands.
// The server answers with one PaneReply and closes the connection. TermID and
// PID are the ones of the announcement: the server serves only the shj that
// holds the primary, and only for the panes that shj created.
//
// Op is "split" (a pane in the workspace of the primary: Cwd, Env as
// "NAME=value"; the reply has its ID, and the GUI shows it and moves the focus
// to it), "alive" (Alive), "show" (the GUI shows the panes again and focuses
// pane ID), "hide" (the GUI hides every pane but the primary and focuses it),
// "send" (Text to pane ID; Enter runs it), "tail" (Lines: the last N lines of
// the pane), "close" (pane ID) and "explorer" (the GUI moves the focus to the
// file explorer of the workspace; Esc there takes it back to the terminal. A
// kisui from before it answers "unknown op"; the keys then stay where Space e
// takes them without a tree) and "changes" (the same for the CHANGES list in
// the sidebar, which kisui shows when PrimaryReply.Changes is true: Space E
// and the "Diff: Go to the changes list" command; an older kisui answers
// "unknown op" the same way).
//
// "open" adds a pane that is not a terminal: Kind says which. "video", "image"
// and "pdf": Path is the absolute path of the file it shows. "browser": URL is the http or https
// address it shows. The reply has its ID; the GUI shows it and moves the focus
// to it. The workspace has one pane of each kind: a new one takes the place of
// the old. "close" also closes such a pane.
type PaneRequest struct {
	Op     string   `json:"op"`
	TermID string   `json:"termId"`
	PID    int      `json:"pid"`
	ID     string   `json:"id,omitempty"`
	Cwd    string   `json:"cwd,omitempty"`
	Kind   string   `json:"kind,omitempty"`
	Path   string   `json:"path,omitempty"`
	URL    string   `json:"url,omitempty"`
	Env    []string `json:"env,omitempty"`
	Text   string   `json:"text,omitempty"`
	Enter  bool     `json:"enter,omitempty"`
	N      int      `json:"n,omitempty"`
}

// PaneReply answers a PaneRequest.
type PaneReply struct {
	OK    bool     `json:"ok"`
	Error string   `json:"error,omitempty"`
	ID    string   `json:"id,omitempty"`
	Alive bool     `json:"alive,omitempty"`
	Lines []string `json:"lines,omitempty"`
}
