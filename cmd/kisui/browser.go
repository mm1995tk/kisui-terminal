package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// "kisui browser": the browser tabs of the window (the built-in browser),
// which the window owns. Each command asks the window (window.go).
// <tab> is the id of a tab ("kisui tab list" prints it) or its name, as in
// "kisui tab". The commands act on the page the way the keys of the dialog of
// a browser tab do; none of them reads or drives the content of a page.

// bookmarkInfo is one bookmark in the answer to "browser.bookmarks".
// "kisui browser bookmark list --json" prints these as they are.
type bookmarkInfo struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

// runBrowserNew is "kisui browser new [--private] [<url>]": add a browser tab
// to the workspace of this pane (a private tab with --private), at the new tab
// page or, with a URL, at that page. It prints the id of the tab.
func runBrowserNew(args []string) int {
	usage := i18n.T("browser.new.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--private"})
	if !ok || len(f.rest) > 1 || (len(f.rest) == 1 && f.rest[0] == "") {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{}
	if f.on["--private"] {
		rq["private"] = true
	}
	if len(f.rest) == 1 {
		rq["url"] = f.rest[0]
	}
	var out struct {
		ID string `json:"id"`
	}
	if code := windowRun("browser new", "browser.new", rq, &out); code != 0 {
		return code
	}
	fmt.Println(out.ID)
	return 0
}

// runBrowserTab is the command "kisui browser <cmd> <tab> [words...]" that
// acts on one tab: words is the number of plain words after the tab, and fill
// puts them in the request. out, if not nil, reads the answer, and show
// prints it. It returns the process exit code.
func runBrowserTab(args []string, cmd string, words int, fill func(rq map[string]any, rest []string), out any, show func()) int {
	usage := i18n.T("browser." + cmd + ".usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, nil)
	if !ok || len(f.rest) != 1+words || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"tab": f.rest[0]}
	if fill != nil {
		fill(rq, f.rest[1:])
	}
	command := "browser." + cmd
	switch cmd {
	case "copy-url":
		command = "browser.copyUrl"
	case "bookmark-add":
		command = "browser.bookmark"
	}
	if code := windowRun("browser "+cmd, command, rq, out); code != 0 {
		return code
	}
	if show != nil {
		show()
	}
	return 0
}

// runBrowserSimple is a command that takes only the tab and prints nothing.
func runBrowserSimple(cmd string) func([]string) int {
	return func(args []string) int {
		return runBrowserTab(args, cmd, 0, nil, nil, nil)
	}
}

// runBrowserURL is "kisui browser url <tab> <url>": open the URL in the tab.
func runBrowserURL(args []string) int {
	return runBrowserTab(args, "url", 1, func(rq map[string]any, rest []string) { rq["url"] = rest[0] }, nil, nil)
}

// runBrowserRename is "kisui browser rename <tab> <name>" (as "kisui tab
// rename"; an empty name gives back the title of the page).
func runBrowserRename(args []string) int {
	return runBrowserTab(args, "rename", 1, func(rq map[string]any, rest []string) { rq["name"] = rest[0] }, nil, nil)
}

// runBrowserCopyURL is "kisui browser copy-url <tab>": print the URL of the
// page. It does not write the clipboard.
func runBrowserCopyURL(args []string) int {
	var out struct {
		URL string `json:"url"`
	}
	return runBrowserTab(args, "copy-url", 0, nil, &out, func() { fmt.Println(out.URL) })
}

// runBrowserFind is "kisui browser find <tab> <text>": look for the text in the
// page. The first match becomes the selection of the page. It prints "found"
// or "not found" (the exit code is 0 for both).
func runBrowserFind(args []string) int {
	var out struct {
		Found bool `json:"found"`
	}
	return runBrowserTab(args, "find", 1, func(rq map[string]any, rest []string) { rq["text"] = rest[0] }, &out, func() {
		if out.Found {
			fmt.Println(i18n.T("browser.find.found"))
		} else {
			fmt.Println(i18n.T("browser.find.notfound"))
		}
	})
}

// runBrowserBookmarkAdd is "kisui browser bookmark add <tab>".
func runBrowserBookmarkAdd(args []string) int {
	return runBrowserTab(args, "bookmark-add", 0, nil, nil, nil)
}

// runBrowserBookmarkList is "kisui browser bookmark list [--json]": the
// bookmarks of the built-in browser, newest first (not those of Firefox).
func runBrowserBookmarkList(args []string) int {
	usage := i18n.T("browser.bookmark-list.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--json"})
	if !ok || len(f.rest) != 0 {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	var out struct {
		Bookmarks []bookmarkInfo `json:"bookmarks"`
	}
	if code := windowRun("browser bookmark list", "browser.bookmarks", map[string]any{}, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		err = writeBookmarkListJSON(os.Stdout, out.Bookmarks)
	} else {
		err = writeBookmarkList(os.Stdout, out.Bookmarks)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("browser bookmark list", err))
		return 1
	}
	return 0
}

// writeBookmarkListJSON writes the bookmarks as {"bookmarks": [...]}, an empty
// list as [].
func writeBookmarkListJSON(w io.Writer, list []bookmarkInfo) error {
	if list == nil {
		list = []bookmarkInfo{}
	}
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(struct {
		Bookmarks []bookmarkInfo `json:"bookmarks"`
	}{list})
}

// writeBookmarkList writes the bookmarks as a table for a person: one line
// each, the URL and the title.
func writeBookmarkList(w io.Writer, list []bookmarkInfo) error {
	rows := [][]string{strings.Split(i18n.T("browser.bookmark-list.header"), "\t")}
	for _, b := range list {
		rows = append(rows, []string{tableCell(b.URL), tableCell(b.Title)})
	}
	_, err := io.WriteString(w, alignColumns(rows, 2))
	return err
}
