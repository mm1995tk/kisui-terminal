package main

import (
	"strings"
	"testing"
)

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestGlobalWindowUsage(t *testing.T) {
	for _, tc := range []struct {
		name string
		run  func([]string) int
		args []string
	}{
		{"sidebar toggle with a word", runSidebarToggle, []string{"x"}},
		{"scale none", runScale, []string{}},
		{"scale unknown", runScale, []string{"bigger"}},
		{"scale two", runScale, []string{"in", "out"}},
		{"notice update with a word", runNoticeUpdate, []string{"x"}},
		{"notice dismiss with a flag", runNoticeDismiss, []string{"--all"}},
		{"notice focus-notified with a word", runNoticeFocusNotified, []string{"x"}},
		{"notice open-download none", runNoticeOpenDownload, []string{}},
		{"notice open-download two", runNoticeOpenDownload, []string{"a", "b"}},
		{"notice open-download blank", runNoticeOpenDownload, []string{" "}},
		{"notice reveal-download with a word", runNoticeRevealDownload, []string{"x"}},
		{"mascot list with a word", runMascotList, []string{"x"}},
		{"mascot select none", runMascotSelect, []string{}},
		{"mascot select blank", runMascotSelect, []string{" "}},
		{"mascot select two", runMascotSelect, []string{"a", "b"}},
		{"mascot reload with a word", runMascotReload, []string{"x"}},
		{"clipboard history with a word", runClipboardHistory, []string{"x"}},
		{"clipboard history unknown flag", runClipboardHistory, []string{"--all"}},
		{"proxy panel none", runProxyPanel, []string{}},
		{"proxy panel two", runProxyPanel, []string{"a", "b"}},
		{"proxy close with a flag", runProxyClose, []string{"--off", "a"}},
		{"proxy stop empty", runProxyStop, []string{""}},
		{"proxy hold none", runProxyHold, []string{"--off"}},
		{"proxy hold unknown flag", runProxyHold, []string{"--on", "a"}},
	} {
		if code := tc.run(tc.args); code != 2 {
			t.Errorf("%s: exit code %d, want 2", tc.name, code)
		}
	}
}

// A command with run and sub runs a sub when the first word names one, and
// run otherwise; the help lists both.
func TestDispatchRunAndSub(t *testing.T) {
	ran := ""
	cmds := []command{
		{name: "proxy", args: "[-v]", help: "help.proxy", run: func(args []string) int { ran = "proxy " + strings.Join(args, " "); return 0 }, sub: []command{
			{name: "stop", args: "<tab>", help: "help.proxy.stop", run: func(args []string) int { ran = "stop " + strings.Join(args, " "); return 0 }},
		}},
	}
	var out, errOut strings.Builder
	for args, want := range map[string]string{"proxy": "proxy ", "proxy -v": "proxy -v", "proxy stop t": "stop t", "proxy t stop": "proxy t stop"} {
		ran = ""
		if code := dispatch(cmds, "kisui", strings.Fields(args), &out, &errOut); code != 0 || ran != want {
			t.Errorf("%s: %d %q, want %q", args, code, ran, want)
		}
	}
	usage(&out, cmds, "kisui")
	for _, want := range []string{"kisui proxy [-v]", "kisui proxy stop <tab>"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the help has no %q:\n%s", want, out.String())
		}
	}
}

// A line of the history is the text on one line, cut when long.
func TestWriteHistory(t *testing.T) {
	var b strings.Builder
	long := strings.Repeat("あ", historyPreview+5)
	if err := writeHistory(&b, []historyEntry{{Text: "a\n  b", CopiedAt: 0}, {Text: long, CopiedAt: 0}}); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(b.String(), "\n"), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "1  ") || !strings.HasSuffix(lines[0], "  a b") {
		t.Fatalf("lines: %q", lines)
	}
	if !strings.HasSuffix(lines[1], strings.Repeat("あ", historyPreview)+"…") {
		t.Errorf("long line: %q", lines[1])
	}
	b.Reset()
	if err := writeHistory(&b, nil); err != nil || b.String() != "" {
		t.Errorf("empty: %q %v", b.String(), err)
	}
}
