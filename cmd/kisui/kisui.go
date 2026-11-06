package cmd

import (
	"fmt"
	"os"

	"github.com/mm1995tk/shijimi-editor/ui/cli"
)

// KisuiMain runs the kisui command with the arguments in os.Args. kisui is
// the server of the GUI: "kisui serve" is the headless server and "kisui attach"
// the bridge to it (shj has neither).
func KisuiMain() {
	if len(os.Args) < 2 {
		kisuiUsage()
		os.Exit(2)
	}
	switch arg := os.Args[1]; arg {
	case "-v", "--version":
		fmt.Println("kisui " + cli.Label())
	case "-h", "--help":
		setLangFromConfig(".")
		kisuiUsage()
	case "serve":
		setLangFromConfig(".")
		os.Exit(runServe(os.Args[2:]))
	case "attach":
		setLangFromConfig(".")
		os.Exit(runAttach(os.Args[2:]))
	default:
		setLangFromConfig(".")
		kisuiUsage()
		os.Exit(2)
	}
}

func kisuiUsage() {
	fmt.Fprintln(os.Stderr, cli.T("kisui.usage"))
}
