package main

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

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/buildinfo"
	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/server"
)

// runServe is "kisui serve": the headless server that GUI clients talk to over
// a Unix socket. It returns the process exit code.
//
// "kisui serve --handover" is not for people: a running serve starts it to hand
// its terminals over (server.handover), with fd 3 connected to itself.
func runServe(args []string) int {
	var handover *os.File
	switch {
	case len(args) == 1 && args[0] == "--handover":
		handover = os.NewFile(3, "handover")
	case len(args) != 0:
		fmt.Fprintln(os.Stderr, i18n.T("serve.usage"))
		return 2
	}
	// refuse tells the old serve why this one cannot take over; it keeps serving.
	refuse := func(err error) {
		if handover != nil {
			server.RefuseHandover(handover, err)
		}
	}
	sock, err := ctl.ServeSocketPath(buildinfo.Suffix())
	if err != nil {
		refuse(err)
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
	cfg, err := config.Load(buildinfo.Suffix())
	// The language is the process's, set from the settings. It is set before
	// the mistakes are reported so that they are in the user's language.
	i18n.SetLang(cfg.UILanguage)
	if err != nil {
		// serve does not start with its settings written wrongly. attach
		// passes this on to the GUI. The keys of shj are not checked here:
		// shj checks them itself when it starts in a pane.
		logger.Error("config", "err", err)
		refuse(fmt.Errorf("%s", configErrorText(err)))
		fmt.Fprintln(os.Stderr, configErrorText(err))
		return 1
	}
	idle := time.Duration(cfg.IdleStopDays) * 24 * time.Hour
	statePath, err := server.StatePath()
	if err != nil {
		logger.Warn("workspaces file", "err", err) // 一覧を保存も復元もしない
	}
	opts := server.Options{
		StatePath:  statePath,
		SocketPath: sock,
		Shj:        server.Shj{Version: ver, Commit: commit, Channel: chName},
		Logger:     logger,
		IdleStop:   idle,
		StartDir:   cfg.StartDir,
	}
	var srv *server.Server
	if handover != nil {
		srv, err = server.Adopt(opts, handover)
	} else {
		srv, err = server.Listen(opts)
	}
	if err != nil {
		logger.Error("start", "err", err)
		if errors.Is(err, server.ErrRunning) {
			fmt.Fprintf(os.Stderr, i18n.T("serve.running")+"\n", sock)
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
