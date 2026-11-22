package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/proxy"
	"github.com/mm1995tk/kisui-terminal/server"
)

// runProxy is "kisui proxy": it runs the recording proxy (package proxy) by
// itself, without the window. It writes the environment variables that send
// another terminal through it to stderr, and a line for each exchange to
// stdout, until it is interrupted. The certificate authority is the one
// "kisui serve" uses on this machine. It returns the process exit code.
func runProxy(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("proxy.usage"))
		return 0
	}
	o, ok := parseProxy(args)
	if !ok {
		fmt.Fprintln(os.Stderr, i18n.T("proxy.usage"))
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintf(os.Stderr, i18n.T("proxy.failed")+"\n", err)
		return 1
	}
	dir, err := server.ProxyCADir()
	if err != nil {
		return fail(err)
	}
	ca, err := proxy.LoadOrCreateCA(dir)
	if err != nil {
		return fail(err)
	}
	ln, err := net.Listen("tcp", o.listen)
	if err != nil {
		return fail(err)
	}
	pr := &flowPrinter{out: os.Stdout, verbose: o.verbose, printed: map[int64]bool{}}
	store := proxy.NewStore(pr.changed)
	pr.store = store
	p := proxy.New(proxy.Options{CA: ca, Store: store})
	if tcp, ok := ln.Addr().(*net.TCPAddr); ok && !tcp.IP.IsLoopback() {
		fmt.Fprintf(os.Stderr, "# "+i18n.T("proxy.open")+"\n", ln.Addr())
	}
	fmt.Fprint(os.Stderr, proxyIntro(ln.Addr().String(), ca))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		p.Close()
	}()
	if err := p.Serve(ln); err != nil {
		return fail(err)
	}
	return 0
}

// proxyOptions is what parseProxy reads.
type proxyOptions struct {
	listen  string
	verbose bool
}

// parseProxy reads the arguments of "kisui proxy": at most one --listen <addr>
// (or --listen=<addr>; host:port, 127.0.0.1 and a free port when it is not
// given) and -v or --verbose. It reports false for anything else.
func parseProxy(args []string) (proxyOptions, bool) {
	o := proxyOptions{listen: "127.0.0.1:0"}
	hasListen := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-v" || a == "--verbose":
			o.verbose = true
		case a == "--listen" || strings.HasPrefix(a, "--listen="):
			if hasListen {
				return o, false
			}
			hasListen = true
			v, found := strings.CutPrefix(a, "--listen=")
			if !found {
				i++
				if i >= len(args) {
					return o, false
				}
				v = args[i]
			}
			if _, _, err := net.SplitHostPort(v); err != nil {
				return o, false
			}
			o.listen = v
		default:
			return o, false
		}
	}
	return o, true
}

// proxyIntro is what "kisui proxy" writes first: where it listens, and the
// lines to paste into another terminal ("export NAME='value'").
func proxyIntro(addr string, ca *proxy.CA) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# "+i18n.T("proxy.listening")+"\n", addr)
	for _, kv := range proxy.Env(addr, ca) {
		name, value, _ := strings.Cut(kv, "=")
		fmt.Fprintf(&b, "export %s=%s\n", name, shellQuote(value))
	}
	fmt.Fprintf(&b, "# "+i18n.T("proxy.ca")+"\n", ca.CertPath())
	return b.String()
}

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// flowPrinter writes a line for each exchange when it ends (and its headers and
// bodies with verbose).
type flowPrinter struct {
	out     io.Writer
	verbose bool
	store   *proxy.Store

	mu      sync.Mutex
	printed map[int64]bool
}

func (pr *flowPrinter) changed(s proxy.Summary) {
	if s.State == proxy.StatePending {
		return
	}
	pr.mu.Lock()
	defer pr.mu.Unlock()
	if pr.printed[s.ID] {
		return
	}
	pr.printed[s.ID] = true
	delete(pr.printed, s.ID-2*proxy.MaxFlows)
	fmt.Fprintln(pr.out, flowLine(s))
	if !pr.verbose {
		return
	}
	if d, ok := pr.store.Detail(s.ID); ok {
		fmt.Fprint(pr.out, flowDetail(d))
	}
}

// flowLine is the line of an exchange: the time it began, the request, and the
// status, the size of the response body and how long it took (or why it failed).
func flowLine(s proxy.Summary) string {
	head := fmt.Sprintf("%s %s %s://%s%s", time.UnixMilli(s.Time).Format("15:04:05"), s.Method, s.Scheme, s.Host, s.Path)
	if s.State == proxy.StateFailed && s.Status == 0 {
		return head + " -> " + i18n.T("proxy.flow.failed") + ": " + s.Error
	}
	line := fmt.Sprintf("%s -> %d %s %dms", head, s.Status, byteSize(s.RespSize), s.DurationMs)
	if s.State == proxy.StateFailed {
		line += " (" + i18n.T("proxy.flow.failed") + ": " + s.Error + ")"
	}
	return line
}

// byteSize is n bytes in a short form (512B, 1.5kB, 2.0MB).
func byteSize(n int64) string {
	switch {
	case n < 1000:
		return fmt.Sprintf("%dB", n)
	case n < 1000*1000:
		return fmt.Sprintf("%.1fkB", float64(n)/1000)
	}
	return fmt.Sprintf("%.1fMB", float64(n)/1000/1000)
}

// flowDetail is the headers and the bodies of an exchange: the lines of the
// request begin with "> ", those of the response with "< ".
func flowDetail(d proxy.Detail) string {
	var b strings.Builder
	side := func(mark string, headers [][2]string, body proxy.BodyView) {
		for _, h := range headers {
			fmt.Fprintf(&b, "%s %s: %s\n", mark, h[0], h[1])
		}
		switch {
		case body.Size == 0:
		case body.Text != nil:
			for _, l := range strings.Split(strings.TrimRight(*body.Text, "\n"), "\n") {
				fmt.Fprintf(&b, "%s %s\n", mark, l)
			}
			if body.Truncated {
				fmt.Fprintf(&b, "%s %s\n", mark, i18n.T("proxy.body.truncated"))
			}
		default:
			fmt.Fprintf(&b, "%s "+i18n.T("proxy.body.binary")+"\n", mark, byteSize(body.Size))
		}
		fmt.Fprintf(&b, "%s\n", mark)
	}
	side(">", d.ReqHeaders, d.ReqBody)
	side("<", d.RespHeaders, d.RespBody)
	return b.String()
}
