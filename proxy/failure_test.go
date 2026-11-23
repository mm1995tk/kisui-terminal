package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestFailureReasons(t *testing.T) {
	past := &x509.Certificate{NotBefore: time.Now().Add(-48 * time.Hour), NotAfter: time.Now().Add(-24 * time.Hour)}
	future := &x509.Certificate{NotBefore: time.Now().Add(24 * time.Hour), NotAfter: time.Now().Add(48 * time.Hour)}
	verify := func(err error) error { return &tls.CertificateVerificationError{Err: err} }
	cases := []struct {
		err  error
		want string
	}{
		{verify(x509.CertificateInvalidError{Cert: past, Reason: x509.Expired}), "cert-expired"},
		{verify(x509.CertificateInvalidError{Cert: future, Reason: x509.Expired}), "cert-not-yet-valid"},
		{verify(x509.CertificateInvalidError{Cert: past, Reason: x509.NotAuthorizedToSign}), "cert-other"},
		{verify(x509.UnknownAuthorityError{}), "cert-untrusted"},
		{verify(x509.HostnameError{Certificate: past, Host: "example.test"}), "cert-name"},
		{verify(errors.New("x509: something else")), "cert-other"},
		{&net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "x.test", IsNotFound: true}}, "host-not-found"},
		{&net.OpError{Op: "dial", Err: &net.DNSError{Err: "i/o timeout", Name: "x.test", IsTimeout: true}}, "timed-out"},
		{&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, "refused"},
		{&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ENETUNREACH)}, "offline"},
		{fmt.Errorf("round trip: %w", context.DeadlineExceeded), "timed-out"},
		{&net.OpError{Op: "read", Err: os.NewSyscallError("read", syscall.ECONNRESET)}, "lost"},
		{io.EOF, "lost"},
		{errors.New("something"), "other"},
	}
	for _, c := range cases {
		if got := failureReason(c.err); got != c.want {
			t.Errorf("failureReason(%v) = %q, want %q", c.err, got, c.want)
		}
	}
}

func TestHeaderSafe(t *testing.T) {
	if got := headerSafe("a\r\nb\x00c—d", 100); got != "a  b c   d" {
		t.Errorf("headerSafe = %q", got)
	}
	if got := headerSafe(strings.Repeat("x", 500), 300); len(got) != 300 {
		t.Errorf("len = %d, want 300", len(got))
	}
}

// 行き先の証明書を信じられないときの 502 に、理由のヘッダーが付く。
func TestMarksAnUntrustedUpstream(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "secret")
	}))
	defer up.Close()
	_, _, ca, addr := startProxy(t, x509.NewCertPool())
	resp, err := clientVia(t, addr, ca.Pool()).Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get(FailureHeader); resp.StatusCode != http.StatusBadGateway || got != "cert-untrusted" {
		t.Errorf("response = %d %s=%q, want 502 cert-untrusted", resp.StatusCode, FailureHeader, got)
	}
	if d := resp.Header.Get(FailureDetailHeader); !strings.Contains(d, "x509") {
		t.Errorf("%s = %q, want the error", FailureDetailHeader, d)
	}
}

// つながらない行き先（誰も待っていないポート）の 502 に、理由のヘッダーが付く。
func TestMarksARefusedUpstream(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := ln.Addr().String()
	ln.Close()
	_, _, ca, addr := startProxy(t, x509.NewCertPool())
	resp, err := clientVia(t, addr, ca.Pool()).Get("http://" + target + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get(FailureHeader); resp.StatusCode != http.StatusBadGateway || got != "refused" {
		t.Errorf("response = %d %s=%q, want 502 refused", resp.StatusCode, FailureHeader, got)
	}
}

// 行き先が、プロキシの失敗のヘッダーを名乗っても、クライアントには渡さない。
func TestUpstreamCannotForgeTheFailure(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(FailureHeader, "cert-expired")
		w.Header().Set(FailureDetailHeader, "forged")
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer up.Close()
	_, _, ca, addr := startProxy(t, upstreamPool(up))
	resp, err := clientVia(t, addr, ca.Pool()).Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Header.Get(FailureHeader) != "" || resp.Header.Get(FailureDetailHeader) != "" {
		t.Errorf("the upstream's failure headers reached the client: %v", resp.Header)
	}
}
