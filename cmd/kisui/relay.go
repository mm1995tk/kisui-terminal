package main

import (
	"fmt"
	"os"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/relay"
)

// runRelay is "kisui relay": on a remote machine, it relays TCP connections to
// the ports of that machine's loopback over stdin/stdout, for the window to open
// a localhost URL of the machine in the browser at hand without ssh's port
// forwarding (docs/design/relay.md). The window runs it through ssh. It returns
// the process exit code.
func runRelay(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("relay.usage"))
		return 2
	}
	if err := relay.Run(relay.Options{In: os.Stdin, Out: os.Stdout}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
