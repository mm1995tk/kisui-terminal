package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWriteBookmarkList(t *testing.T) {
	var b strings.Builder
	if err := writeBookmarkList(&b, []bookmarkInfo{{URL: "https://a.example/", Title: ""}}); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 2 || strings.Fields(lines[1])[0] != "https://a.example/" || strings.Fields(lines[1])[1] != "-" {
		t.Errorf("table: %q", b.String())
	}

	b.Reset()
	if err := writeBookmarkListJSON(&b, nil); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Bookmarks []bookmarkInfo `json:"bookmarks"`
	}
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil || got.Bookmarks == nil {
		t.Fatalf("no bookmarks must be an empty list: %q %v", b.String(), err)
	}
}

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestBrowserUsage(t *testing.T) {
	for _, tc := range []struct {
		run  func([]string) int
		args []string
	}{
		{runBrowserNew, []string{"a", "b"}},
		{runBrowserNew, []string{"--bogus"}},
		{runBrowserURL, []string{"tab"}},
		{runBrowserURL, []string{"", "https://a.example"}},
		{runBrowserRename, []string{"tab"}},
		{runBrowserSimple("back"), []string{}},
		{runBrowserSimple("close"), []string{"a", "b"}},
		{runBrowserCopyURL, []string{}},
		{runBrowserFind, []string{"tab"}},
		{runBrowserBookmarkAdd, []string{}},
		{runBrowserBookmarkList, []string{"extra"}},
	} {
		if code := tc.run(tc.args); code != 2 {
			t.Errorf("%q: exit code %d, want 2", tc.args, code)
		}
	}
}
