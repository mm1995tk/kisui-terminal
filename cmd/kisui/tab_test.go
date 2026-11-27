package main

import (
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

func TestParseFlags(t *testing.T) {
	value, toggle := []string{"--workspace"}, []string{"--up", "--force"}
	for _, tc := range []struct {
		args  []string
		value map[string]string
		on    []string
		rest  []string
		ok    bool
	}{
		{[]string{"a", "b"}, nil, nil, []string{"a", "b"}, true},
		{[]string{"--workspace", "w", "a"}, map[string]string{"--workspace": "w"}, nil, []string{"a"}, true},
		{[]string{"a", "--workspace=x y", "--up"}, map[string]string{"--workspace": "x y"}, []string{"--up"}, []string{"a"}, true},
		{[]string{"a", ""}, nil, nil, []string{"a", ""}, true},
		{[]string{"--force", "--", "--up", "-x"}, nil, []string{"--force"}, []string{"--up", "-x"}, true},
		{[]string{"-"}, nil, nil, []string{"-"}, true},
		{[]string{"--workspace"}, nil, nil, nil, false},
		{[]string{"--workspace", " "}, nil, nil, nil, false},
		{[]string{"--workspace", "a", "--workspace", "b"}, nil, nil, nil, false},
		{[]string{"--up", "--up"}, nil, nil, nil, false},
		{[]string{"--up=1"}, nil, nil, nil, false},
		{[]string{"--bogus"}, nil, nil, nil, false},
		{[]string{"-f"}, nil, nil, nil, false},
	} {
		f, ok := parseFlags(tc.args, value, toggle)
		if ok != tc.ok {
			t.Errorf("parseFlags(%q) ok = %v, want %v", tc.args, ok, tc.ok)
			continue
		}
		if !ok {
			continue
		}
		on := slices.Sorted(maps.Keys(f.on))
		if (len(tc.value) != 0 || len(f.value) != 0) && !maps.Equal(f.value, tc.value) || !slices.Equal(on, tc.on) || !slices.Equal(f.rest, tc.rest) {
			t.Errorf("parseFlags(%q) = %+v, want value %v on %v rest %q", tc.args, f, tc.value, tc.on, tc.rest)
		}
	}
}

func TestWriteTabList(t *testing.T) {
	tabs := []tabInfo{
		{ID: "wabc", Name: "repo", Kind: "terminal", Workspace: "gabcdefghij", WorkspaceName: "作業用", Machine: "local", Shown: true, Self: true},
		{ID: "tdef", Name: "Docs\tpage", Kind: "browser", Workspace: "gabcdefghij", WorkspaceName: "作業用", Machine: "local"},
	}
	var b strings.Builder
	if err := writeTabList(&b, tabs); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("a header and a line for each tab:\n%s", b.String())
	}
	if !strings.HasPrefix(lines[1], "* wabc  repo") || !strings.Contains(lines[1], "terminal  gabcdefghij 作業用  local") || !strings.HasSuffix(lines[1], i18n.T("tab.list.shown")) {
		t.Errorf("the line of the own tab: %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "  tdef  Docs page") || !strings.HasSuffix(lines[2], "-") {
		t.Errorf("the line of the browser tab: %q", lines[2])
	}

	b.Reset()
	if err := writeTabListJSON(&b, nil); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Tabs []tabInfo `json:"tabs"`
	}
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil || got.Tabs == nil {
		t.Fatalf("no tabs must be an empty list: %q %v", b.String(), err)
	}
}

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestTabUsage(t *testing.T) {
	for _, tc := range []struct {
		run  func([]string) int
		args []string
	}{
		{runTabList, []string{"extra"}},
		{runTabList, []string{"--workspace"}},
		{runTabRename, []string{"a"}},
		{runTabRename, []string{"a", "b", "c"}},
		{runTabClose, []string{}},
		{runTabClose, []string{"--bogus", "a"}},
		{runTabShow, []string{""}},
		{runTabMove, []string{"a"}},
		{runTabMove, []string{"a", "--up", "--down"}},
		{runTabMove, []string{"a", "--up", "--workspace", "w"}},
		{runTabMove, []string{"--up"}},
	} {
		if code := tc.run(tc.args); code != 2 {
			t.Errorf("%q: exit code %d, want 2", tc.args, code)
		}
	}
}
