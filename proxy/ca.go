package proxy

// プロキシの認証局（#409）。HTTPS の中身を見るために、行き先ごとの証明書をその場で作って署名する。
// 認証局はマシンごとに 1 つで、kisui の状態を置くフォルダに置く。OS には入れない。信じるのは、プロキシに通すと
// 決めたもの（環境変数を渡したペインなど）だけ。

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// caKeyFile は認証局の秘密鍵と証明書（PEM を 2 つ続けたもの）。持ち主だけが読める（0600）。
	caKeyFile = "proxy-ca-key.pem"
	// caCertFile は認証局の証明書だけ。信じさせるプログラムに渡す（NODE_EXTRA_CA_CERTS など）。
	caCertFile = "proxy-ca.pem"
	// caBundleFile は OS の認証局の束に、この認証局を足したもの（SSL_CERT_FILE など、束を丸ごと置き換える変数に渡す）。
	caBundleFile = "proxy-ca-bundle.pem"

	caValid   = 10 * 365 * 24 * time.Hour
	leafValid = 30 * 24 * time.Hour
	// maxLeaves は覚えておく行き先ごとの証明書の数。超えたら全部捨てて作り直す。
	maxLeaves = 2000
)

// CA は自前の認証局。行き先の名前ごとの証明書を作って覚える。
type CA struct {
	dir  string
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte // 証明書の PEM

	mu      sync.Mutex
	leafKey *ecdsa.PrivateKey // 行き先ごとの証明書に共通の鍵（証明書を作るたびに鍵を作らない）
	leaves  map[string]*tls.Certificate
	now     func() time.Time
}

// LoadOrCreateCA は dir の認証局を読む。無ければ作って置く（dir は 0700、秘密鍵は 0600）。
// 証明書だけのファイルと、OS の束に足したファイルも、同じフォルダに書き直す。
func LoadOrCreateCA(dir string) (*CA, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(dir, caKeyFile)
	cert, key, err := readCA(keyPath)
	if errors.Is(err, os.ErrNotExist) {
		if err := createCA(keyPath); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		// 同時に起動した別の kisui が先に作っていれば、そちらを読む。
		cert, key, err = readCA(keyPath)
	}
	if err != nil {
		return nil, fmt.Errorf("proxy CA %s: %w", keyPath, err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	ca := &CA{
		dir: dir, cert: cert, key: key, leafKey: leafKey,
		pem:    pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}),
		leaves: map[string]*tls.Certificate{},
		now:    time.Now,
	}
	if err := writeIfChanged(ca.CertPath(), ca.pem, 0o644); err != nil {
		return nil, err
	}
	if err := writeIfChanged(ca.BundlePath(), bundle(systemBundle(), ca.pem), 0o644); err != nil {
		return nil, err
	}
	return ca, nil
}

// CertPath は認証局の証明書だけのファイル。
func (c *CA) CertPath() string { return filepath.Join(c.dir, caCertFile) }

// BundlePath は OS の認証局の束に、この認証局を足したファイル。
func (c *CA) BundlePath() string { return filepath.Join(c.dir, caBundleFile) }

// CertPEM は認証局の証明書の PEM。
func (c *CA) CertPEM() []byte { return bytes.Clone(c.pem) }

// Pool は、この認証局だけを信じる束（テストと、プロキシ越しにつなぐクライアント用）。
func (c *CA) Pool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(c.cert)
	return p
}

func readCA(path string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return nil, nil, fmt.Errorf("the private key is readable by others (mode %04o); it must be 0600", fi.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var cert *x509.Certificate
	var key *ecdsa.PrivateKey
	for {
		var b *pem.Block
		b, data = pem.Decode(data)
		if b == nil {
			break
		}
		switch b.Type {
		case "CERTIFICATE":
			if cert, err = x509.ParseCertificate(b.Bytes); err != nil {
				return nil, nil, err
			}
		case "EC PRIVATE KEY":
			if key, err = x509.ParseECPrivateKey(b.Bytes); err != nil {
				return nil, nil, err
			}
		}
	}
	if cert == nil || key == nil {
		return nil, nil, errors.New("no certificate or no private key in the file")
	}
	if pub, ok := cert.PublicKey.(*ecdsa.PublicKey); !ok || !pub.Equal(&key.PublicKey) {
		return nil, nil, errors.New("the certificate and the private key do not match")
	}
	return cert, key, nil
}

// createCA は認証局を作って path に置く。途中の中身を別の kisui が読まないよう、別の名前に書いてからリンクする
// （すでにあれば os.ErrExist。先に作った方を使う）。
func createCA(path string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := newSerial()
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "localhost"
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "kisui-terminal proxy CA (" + host + ")", Organization: []string{"kisui-terminal"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(caValid),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	_ = pem.Encode(&buf, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	_ = pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	f, err := os.CreateTemp(filepath.Dir(path), ".proxy-ca-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Link(tmp, path)
}

func newSerial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

// leaf は行き先の名前（ホスト名か IP アドレス）の証明書。作ったものは覚えておく。
func (c *CA) leaf(name string) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if l := c.leaves[name]; l != nil && now.Before(l.Leaf.NotAfter.Add(-time.Hour)) {
		return l, nil
	}
	serial, err := newSerial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(leafValid),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(name); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{name}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &c.leafKey.PublicKey, c.key)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	if len(c.leaves) >= maxLeaves {
		clear(c.leaves)
	}
	l := &tls.Certificate{Certificate: [][]byte{der, c.cert.Raw}, PrivateKey: c.leafKey, Leaf: parsed}
	c.leaves[name] = l
	return l, nil
}

// systemBundlePaths は OS の認証局の束がある場所の候補（Go の crypto/x509 が見る場所と同じ並び）。
var systemBundlePaths = []string{
	"/etc/ssl/certs/ca-certificates.crt",                // Debian・Ubuntu・NixOS・Arch
	"/etc/pki/tls/certs/ca-bundle.crt",                  // Fedora・RHEL
	"/etc/ssl/ca-bundle.pem",                            // openSUSE
	"/etc/pki/tls/cacert.pem",                           // OpenELEC
	"/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // CentOS・RHEL 7
	"/etc/ssl/cert.pem",                                 // Alpine・macOS
}

// systemBundle は OS の認証局の束（PEM）。SSL_CERT_FILE があればそれ。見つからなければ nil。
func systemBundle() []byte {
	paths := systemBundlePaths
	if p := os.Getenv("SSL_CERT_FILE"); p != "" && filepath.Base(p) != caBundleFile {
		paths = append([]string{p}, paths...)
	}
	for _, p := range paths {
		if data, err := os.ReadFile(p); err == nil && bytes.Contains(data, []byte("BEGIN CERTIFICATE")) {
			return data
		}
	}
	return nil
}

// bundle は OS の束に認証局の証明書を足したもの。
func bundle(system, ca []byte) []byte {
	var b bytes.Buffer
	b.Write(system)
	if len(system) > 0 && !bytes.HasSuffix(system, []byte("\n")) {
		b.WriteByte('\n')
	}
	b.Write(ca)
	return b.Bytes()
}

// writeIfChanged は path の中身が data と違うときだけ、別の名前に書いてから置き換える。
func writeIfChanged(path string, data []byte, mode os.FileMode) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return nil
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".proxy-tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
