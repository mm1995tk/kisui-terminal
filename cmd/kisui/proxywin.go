package main

import (
	"fmt"
	"os"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// "kisui proxy panel|close|stop|hold <tab>" (#517): send a tab of the window
// through the proxy of the window, as the keys of the proxy do. Each asks the
// window (window.go); <tab> is the id or the name of a terminal tab or a
// browser tab, as for "kisui tab". The window takes them only from a pane of
// the computer it runs on. "kisui proxy" without one of these words runs the
// proxy by itself (proxy.go).

// runProxyPanel is "kisui proxy panel <tab>": open the proxy panel of the tab,
// and send the tab through the proxy if it is not yet.
func runProxyPanel(args []string) int {
	return runProxyTo(args, "panel", "proxy.panel", nil, func(map[string]any, flags) {})
}

// runProxyClose is "kisui proxy close <tab>": close the proxy panel of the
// tab. The tab stays on the proxy.
func runProxyClose(args []string) int {
	return runProxyTo(args, "close", "proxy.close", nil, func(map[string]any, flags) {})
}

// runProxyStop is "kisui proxy stop <tab>": stop sending the tab through the
// proxy (its panel closes too).
func runProxyStop(args []string) int {
	return runProxyTo(args, "stop", "proxy.stop", nil, func(map[string]any, flags) {})
}

// runProxyHold is "kisui proxy hold [--off] <tab>": hold the requests of the
// tab before they go out (--off: stop holding; the held ones go out).
func runProxyHold(args []string) int {
	return runProxyTo(args, "hold", "proxy.hold", []string{"--off"}, func(rq map[string]any, f flags) {
		if f.on["--off"] {
			rq["off"] = true
		}
	})
}

// runProxyTo runs a "kisui proxy <cmd> <tab>": args has the tab and at most
// the flags of toggle, and fill puts them in the request. It returns the
// process exit code.
func runProxyTo(args []string, cmd, command string, toggle []string, fill func(rq map[string]any, f flags)) int {
	usage := i18n.T("proxy." + cmd + ".usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, toggle)
	if !ok || len(f.rest) != 1 || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"tab": f.rest[0]}
	fill(rq, f)
	return windowRun("proxy "+cmd, command, rq, nil)
}
