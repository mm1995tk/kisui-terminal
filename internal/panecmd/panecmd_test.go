package panecmd

import "testing"

func TestHasScheme(t *testing.T) {
	for s, want := range map[string]bool{
		"https://example.com": true,
		"http://x":            true,
		"ftp://x":             true,
		"a.png":               false,
		"./a://b":             false,
		"/tmp/x://y":          false,
		"a.b://c":             false,
		"://x":                false,
	} {
		if got := HasScheme(s); got != want {
			t.Errorf("HasScheme(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv(EnvSocket, "/s")
	t.Setenv(EnvPane, "t1")
	t.Setenv(EnvToken, "")
	if _, err := FromEnv(); err != ErrNotInPane {
		t.Fatalf("without a secret: %v", err)
	}
	t.Setenv(EnvToken, "x")
	if p, err := FromEnv(); err != nil || p != (Pane{Socket: "/s", ID: "t1", Token: "x"}) {
		t.Fatalf("%+v %v", p, err)
	}
}
