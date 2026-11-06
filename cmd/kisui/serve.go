package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mm1995tk/shijimi-editor/core/config"
	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/ui/cli"
	guicfg "github.com/mm1995tk/shijimi-editor/ui/gui/config"
	"github.com/mm1995tk/shijimi-editor/ui/gui/server"
)

// runServe is "kisui serve": the headless server that GUI clients talk to over
// a Unix socket. It returns the process exit code.
func runServe(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, cli.T("serve.usage"))
		return 2
	}
	sock, err := ctl.ServeSocketPath(cli.Suffix())
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
	ver, commit := cli.Resolve()
	chName := "stable"
	if cli.IsNightly() {
		chName = cli.Nightly
	}
	logger := slog.New(slog.NewTextHandler(logw, nil))
	var idle time.Duration
	var startDir string
	if home, err := os.UserHomeDir(); err == nil {
		cfg, err := config.Load(home, configOptions())
		// The language is the process's, set from the home config. It is set
		// before the mistakes are reported so that they are in the user's language.
		cli.SetLangFrom(cfg)
		if err != nil {
			// serve does not start with settings it cannot read as written. attach
			// passes this on to the GUI.
			logger.Error("config", "err", cli.ErrText(err))
			fmt.Fprintln(os.Stderr, configErrorText(err))
			return 1
		}
		// keys this version does not read do not stop serve: say so and go on
		for _, w := range cfg.Warnings {
			logger.Warn("config", "ignored", cli.Text(w.Msg()))
			fmt.Fprintln(os.Stderr, cli.T("config.warn.prefix")+cli.Text(w.Msg()))
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
			fmt.Fprintf(os.Stderr, cli.T("serve.running")+"\n", sock)
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
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
