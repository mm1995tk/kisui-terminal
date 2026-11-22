package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/proxy"
)

func TestParseProxy(t *testing.T) {
	for _, c := range []struct {
		args    []string
		listen  string
		verbose bool
		ok      bool
	}{
		{nil, "127.0.0.1:0", false, true},
		{[]string{"-v"}, "127.0.0.1:0", true, true},
		{[]string{"--listen", "127.0.0.1:8080", "--verbose"}, "127.0.0.1:8080", true, true},
		{[]string{"--listen=[::1]:9000"}, "[::1]:9000", false, true},
		{[]string{"--listen"}, "", false, false},
		{[]string{"--listen", "8080"}, "", false, false},
		{[]string{"--listen", "a:1", "--listen", "b:2"}, "", false, false},
		{[]string{"extra"}, "", false, false},
	} {
		o, ok := parseProxy(c.args)
		if ok != c.ok || (ok && (o.listen != c.listen || o.verbose != c.verbose)) {
			t.Errorf("parseProxy(%v) = %+v, %v", c.args, o, ok)
		}
	}
}

func TestProxyIntroExportsTheProxyAndTheCA(t *testing.T) {
	ca, err := proxy.LoadOrCreateCA(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := proxyIntro("127.0.0.1:4321", ca)
	for _, want := range []string{
		"export HTTPS_PROXY='http://127.0.0.1:4321'\n",
		"export SSL_CERT_FILE='" + ca.BundlePath() + "'\n",
		"export NODE_EXTRA_CA_CERTS='" + ca.CertPath() + "'\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("the intro lacks %q:\n%s", want, s)
		}
	}
	for l := range strings.SplitSeq(strings.TrimSpace(s), "\n") {
		if !strings.HasPrefix(l, "# ") && !strings.HasPrefix(l, "export ") {
			t.Errorf("a line that a shell cannot run: %q", l)
		}
	}
	if got := shellQuote("a'b"); got != `'a'\''b'` {
		t.Errorf("shellQuote = %s", got)
	}
}

func TestFlowPrinterPrintsEachExchangeOnce(t *testing.T) {
	var out bytes.Buffer
	pr := &flowPrinter{out: &out, printed: map[int64]bool{}}
	done := proxy.Summary{ID: 1, Time: 0, Method: "GET", Scheme: "https", Host: "example.com", Path: "/a?b=1", Status: 200, State: proxy.StateDone, RespSize: 1536, DurationMs: 42}
	pending := done
	pending.State = proxy.StatePending
	pr.changed(pending)
	pr.changed(done)
	pr.changed(done)
	pr.changed(proxy.Summary{ID: 2, Method: "GET", Scheme: "https", Host: "bad.example", Path: "/", State: proxy.StateFailed, Error: "no such host"})
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %q", lines)
	}
	if !strings.HasSuffix(lines[0], " GET https://example.com/a?b=1 -> 200 1.5kB 42ms") {
		t.Errorf("line of a finished exchange: %q", lines[0])
	}
	if !strings.HasSuffix(lines[1], " GET https://bad.example/ -> failed: no such host") {
		t.Errorf("line of a failed exchange: %q", lines[1])
	}
}

func TestFlowDetailMarksTheSides(t *testing.T) {
	text := "{\"ok\":true}\n"
	d := proxy.Detail{
		ReqHeaders:  [][2]string{{"Accept", "*/*"}},
		RespHeaders: [][2]string{{"Content-Type", "application/json"}},
		RespBody:    proxy.BodyView{Size: 12, Text: &text},
		ReqBody:     proxy.BodyView{Size: 2048, Binary: true},
	}
	want := "> Accept: */*\n> (a body that is not text: 2.0kB)\n>\n< Content-Type: application/json\n< {\"ok\":true}\n<\n"
	if got := flowDetail(d); got != want {
		t.Errorf("flowDetail =\n%s\nwant\n%s", got, want)
	}
}
