// Command kisui is the server of kisui-terminal: "kisui serve" is the headless
// server the GUI talks to and "kisui attach" the bridge to it.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/buildinfo"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "-v", "--version":
		fmt.Println("kisui " + buildinfo.Label())
	case "-h", "--help":
		setLang()
		usage()
	case "serve":
		setLang()
		os.Exit(runServe(os.Args[2:]))
	case "attach":
		setLang()
		os.Exit(runAttach(os.Args[2:]))
	default:
		setLang()
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, i18n.T("kisui.usage"))
}

// setLang sets the language of the messages from the settings, for the
// commands that need nothing else from them. A mistake in the files is not
// reported here: serve reports it, and the others work without settings.
func setLang() {
	cfg, _ := config.Load(buildinfo.Suffix())
	i18n.SetLang(cfg.UILanguage)
}

// configErrorText is err for a terminal: a *config.Error gets a heading with
// its count.
func configErrorText(err error) string {
	if ce, ok := errors.AsType[*config.Error](err); ok {
		return fmt.Sprintf(i18n.T("config.err.head"), len(ce.Problems)) + "\n" + ce.Error()
	}
	return err.Error()
}
