package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"syscall"
	"time"
)

// 行き先につながらなかった（証明書が正しくない・名前が引けない・つながらないなど）ときに、プロキシが返す 502 に付ける
// ヘッダー。内蔵ブラウザのタブ（kisui-terminal の殻。app/src-tauri/src/browser_load.rs）は、これを見て、ページの代わりに
// 「開けなかった」画面を出す（#432）。値は、殻と画面の理由の分類と同じ名前（failureReason）。
//
// 行き先が同じ名前のヘッダーを返しても、クライアントには渡さない（stripFailureHeaders）。ページが「開けなかった」画面を
// 出させられないように。
const (
	FailureHeader       = "X-Kisui-Proxy-Error"
	FailureDetailHeader = "X-Kisui-Proxy-Error-Detail"
)

// maxFailureDetail は FailureDetailHeader の長さの上限（バイト）。
const maxFailureDetail = 300

// failureReason は、行き先との 1 往復の失敗から、理由の分類を選ぶ。名前は、内蔵ブラウザの殻の理由
// （app/src-tauri/src/browser_load.rs の Reason）と同じ。
func failureReason(err error) string {
	var (
		invalid  x509.CertificateInvalidError
		unknown  x509.UnknownAuthorityError
		hostname x509.HostnameError
		dns      *net.DNSError
		ne       net.Error
	)
	switch {
	case errors.As(err, &invalid):
		if invalid.Reason != x509.Expired {
			return "cert-other"
		}
		// Go は、期限切れも、まだ有効でないのも Expired にする
		if invalid.Cert != nil && time.Now().Before(invalid.Cert.NotBefore) {
			return "cert-not-yet-valid"
		}
		return "cert-expired"
	case errors.As(err, &unknown):
		return "cert-untrusted"
	case errors.As(err, &hostname):
		return "cert-name"
	case isCertificateError(err):
		return "cert-other"
	case errors.As(err, &dns):
		if dns.IsTimeout {
			return "timed-out"
		}
		return "host-not-found"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "offline"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "timed-out"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return "lost"
	}
	return "other"
}

// isCertificateError は、行き先の証明書を確かめられなかった失敗か（上で見分けたもの以外）。
func isCertificateError(err error) bool {
	var (
		verify      *tls.CertificateVerificationError
		constraints x509.ConstraintViolationError
		insecure    x509.InsecureAlgorithmError
	)
	return errors.As(err, &verify) || errors.As(err, &constraints) || errors.As(err, &insecure)
}

// setFailure は、行き先につながらなかった応答に、理由のヘッダーを付ける。
func setFailure(h http.Header, err error) {
	h.Set(FailureHeader, failureReason(err))
	h.Set(FailureDetailHeader, headerSafe(err.Error(), maxFailureDetail))
}

// stripFailureHeaders は、行き先が返した応答から、プロキシの失敗のヘッダーを消す。
func stripFailureHeaders(h http.Header) {
	h.Del(FailureHeader)
	h.Del(FailureDetailHeader)
}

// headerSafe は、s をヘッダーの値に書ける字（表示できる ASCII と空白）だけにし、max バイトで切る。
func headerSafe(s string, max int) string {
	b := make([]byte, 0, min(len(s), max))
	for i := 0; i < len(s) && len(b) < max; i++ {
		c := s[i]
		if c < 0x20 || c > 0x7e {
			c = ' '
		}
		b = append(b, c)
	}
	return string(b)
}
