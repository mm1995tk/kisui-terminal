package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mm1995tk/shijimi-editor/core"
	"github.com/mm1995tk/shijimi-editor/core/buildinfo"
	"github.com/mm1995tk/shijimi-editor/core/config"
	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/core/i18n"
	"github.com/mm1995tk/shijimi-editor/core/ide"
	uicfg "github.com/mm1995tk/shijimi-editor/core/uicfg"
	guicfg "github.com/mm1995tk/shijimi-editor/ui/gui/config"
	"github.com/mm1995tk/shijimi-editor/ui/gui/server"
)

// runServe is "shj serve": the headless server that GUI clients talk to over
// a Unix socket. It returns the process exit code.
func runServe(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("serve.usage"))
		return 2
	}
	sock, err := ctl.ServeSocketPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// The log goes to a file because the server runs detached from a terminal.
	var logw io.Writer = io.Discard
	if path, err := server.LogPath(); err == nil {
		f, err := server.OpenLog(path, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		} else {
			defer f.Close()
			logw = f
		}
	} else {
		fmt.Fprintln(os.Stderr, err)
	}
	ver, commit := buildinfo.Resolve()
	chName := "stable"
	if buildinfo.IsNightly() {
		chName = buildinfo.Nightly
	}
	logger := slog.New(slog.NewTextHandler(logw, nil))
	var idle time.Duration
	var startDir string
	if home, err := os.UserHomeDir(); err == nil {
		cfg, err := config.Load(home, configOptions())
		// The language is the process's: the home config sets it once, and
		// the workspaces' cores leave it alone (core.NewIn). It is set before the
		// mistakes are reported so that they are in the user's language.
		i18n.SetLang(uicfg.Of(cfg).UILanguage)
		if err != nil {
			// serve does not start with settings it cannot read as written. attach
			// passes this on to the GUI.
			logger.Error("config", "err", err)
			fmt.Fprintln(os.Stderr, configErrorText(err))
			return 1
		}
		idle = time.Duration(guicfg.Of(cfg).IdleStopDays) * 24 * time.Hour
		startDir = guicfg.Of(cfg).StartDir
	}
	statePath, err := server.StatePath()
	if err != nil {
		logger.Warn("workspaces file", "err", err) // 一覧を保存も復元もしない
	}
	srv, err := server.Listen(server.Options{
		StatePath:  statePath,
		SocketPath: sock,
		Shj:        server.Shj{Version: ver, Commit: commit, Channel: chName},
		Logger:     logger,
		IdleStop:   idle,
		StartDir:   startDir,
	})
	if err != nil {
		if errors.Is(err, server.ErrRunning) {
			fmt.Fprintf(os.Stderr, i18n.T("serve.running")+"\n", sock)
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
	}
	// A core per workspace, on one set of process-wide parts. A core is made
	// when its workspace takes the focus and kept while it has files open.
	shared := core.NewShared(coreBuild())
	defer shared.Close()
	cores := core.NewWorkspaces(shared)
	cores.SetPort(srv)
	defer cores.CloseAll()
	// What a core does on its own (a language server replied, a timer fired) is
	// sent to the GUI like what it did for an input.
	cores.SetOnChange(srv.ScreenChanged)
	srv.SetCores(serveCores{cores, logger})
	srv.SetScreens(serveCores{cores, logger})
	srv.SetInputs(serveCores{cores, logger})
	srv.AddBeforeStop(func() { writeBackups(cores, logger) })
	// Like the TUI, the control socket and the Claude Code connection are best
	// effort. The server has one of each for all workspaces; requests go to the
	// focused workspace. The socket is <pid>.sock as in the TUI, so shj finds it
	// by the same rules; the environment is set before any terminal is created,
	// so shells in the server's terminals reach this server directly.
	if path, err := ctl.SocketPath(); err == nil {
		if err := srv.StartControl(path); err == nil {
			os.Setenv(ctl.EnvSocket, path)
		} else {
			logger.Warn("control socket", "err", err)
		}
	}
	// The lock file names the home directory as the workspace folder: Claude
	// Code connects when its directory is inside one, and the server does not
	// know the workspaces' roots when it starts.
	if home, err := os.UserHomeDir(); err == nil {
		if is, err := srv.StartIDE(home, core.IDETools()); err == nil {
			os.Setenv(ide.EnvPort, strconv.Itoa(is.Port()))
			os.Setenv(ide.EnvEnable, "true")
			os.Setenv(ide.EnvForceTerminal, "true")
		} else {
			logger.Warn("ide", "err", err)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Serve(ctx); err != nil {
		logger.Error("serve", "err", err)
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
