package db

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/mm1995tk/kisui-terminal/config"
)

// testCA makes a certificate authority and a certificate it signs for
// localhost. It returns the file of the authority (PEM) and the certificate.
func testCA(t *testing.T) (caFile string, cert tls.Certificate) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "kisui test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		DNSNames: []string{"localhost"}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caFile = filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return caFile, tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func TestPgTLS(t *testing.T) {
	caFile, _ := testCA(t)
	// Neither the environment nor ~/.postgresql/root.crt changes what the
	// settings say.
	t.Setenv("PGSSLMODE", "disable")
	t.Setenv("PGSSLROOTCERT", caFile)
	c := config.DBLogin{Kind: config.DBPostgres, Host: "db.example.com", Port: 5432, User: "u"}
	for _, mode := range []string{"", config.DBTLSPrefer, config.DBTLSDisable, config.DBTLSRequire} {
		c.TLS = mode
		cfg, err := pgConfig(c)
		if err != nil {
			t.Fatalf("%q: %v", mode, err)
		}
		tc := cfg.TLSConfig
		switch mode {
		case config.DBTLSDisable:
			if tc != nil || len(cfg.Fallbacks) != 0 {
				t.Errorf("disable uses TLS: %+v, %d fallbacks", tc, len(cfg.Fallbacks))
			}
		case config.DBTLSRequire:
			// No certificate checked (PGSSLROOTCERT would make it verify-ca),
			// and no login without TLS.
			if tc == nil || !tc.InsecureSkipVerify || tc.VerifyPeerCertificate != nil || len(cfg.Fallbacks) != 0 {
				t.Errorf("require: %+v, %d fallbacks", tc, len(cfg.Fallbacks))
			}
		default:
			// prefer: TLS without checking, then without TLS.
			if tc == nil || !tc.InsecureSkipVerify || len(cfg.Fallbacks) != 1 || cfg.Fallbacks[0].TLSConfig != nil {
				t.Errorf("%q: %+v, %d fallbacks", mode, tc, len(cfg.Fallbacks))
			}
		}
	}
	c.TLS, c.TLSCA = config.DBTLSVerify, caFile
	cfg, err := pgConfig(c)
	if err != nil {
		t.Fatal(err)
	}
	if tc := cfg.TLSConfig; tc == nil || tc.InsecureSkipVerify || tc.ServerName != "db.example.com" || tc.RootCAs == nil || len(cfg.Fallbacks) != 0 {
		t.Errorf("verify: %+v, %d fallbacks", tc, len(cfg.Fallbacks))
	}
	c.TLSCA = filepath.Join(t.TempDir(), "missing.pem")
	if _, err := Open(context.Background(), c, "pw"); err == nil || !strings.Contains(err.Error(), "CA") {
		t.Errorf("a missing tls-ca: %v", err)
	}
}

// pgTLSServer listens on localhost like a PostgreSQL server that offers TLS
// with cert, and tells for each login whether the TLS handshake went
// through ("plain" for a login that did not ask for TLS).
func pgTLSServer(t *testing.T, cert tls.Certificate) (port int, results <-chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	ch := make(chan string, 4)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			var head [8]byte
			if _, err := io.ReadFull(conn, head[:]); err != nil {
				conn.Close()
				continue
			}
			// The SSLRequest: length 8, code 80877103.
			if binary.BigEndian.Uint32(head[4:]) != 80877103 {
				ch <- "plain"
				conn.Close()
				continue
			}
			conn.Write([]byte("S"))
			tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
			if err := tc.Handshake(); err != nil {
				ch <- "failed"
			} else {
				ch <- "tls"
			}
			tc.Close()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, ch
}

// verify checks the certificate and its host name; require takes any
// certificate; disable never asks for TLS.
func TestPgTLSHandshake(t *testing.T) {
	caFile, cert := testCA(t)
	otherCA, _ := testCA(t)
	port, results := pgTLSServer(t, cert)
	for _, c := range []struct {
		name, tls, ca, host, want string
	}{
		{"verify", config.DBTLSVerify, caFile, "localhost", "tls"},
		{"verify, another authority", config.DBTLSVerify, otherCA, "localhost", "failed"},
		{"verify, another host name", config.DBTLSVerify, caFile, "127.0.0.1", "failed"},
		{"require, another authority", config.DBTLSRequire, "", "localhost", "tls"},
		{"disable", config.DBTLSDisable, "", "localhost", "plain"},
	} {
		login := config.DBLogin{Kind: config.DBPostgres, Host: c.host, Port: port, User: "u", TLS: c.tls, TLSCA: c.ca}
		_, err := Open(context.Background(), login, "pw")
		if err == nil {
			t.Errorf("%s: logged in to a server that is not one", c.name)
		}
		select {
		case got := <-results:
			if got != c.want {
				t.Errorf("%s: %s, want %s (%v)", c.name, got, c.want, err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: the server saw no login (%v)", c.name, err)
		}
		// verify, when the handshake fails, does not try again without TLS.
		select {
		case got := <-results:
			t.Errorf("%s: a second login: %s", c.name, got)
		default:
		}
	}
}

func TestMyTLS(t *testing.T) {
	caFile, _ := testCA(t)
	c := config.DBLogin{Kind: config.DBMySQL, Host: "db.example.com", Port: 3306, User: "u"}
	for mode, want := range map[string]string{
		"":                  "preferred",
		config.DBTLSPrefer:  "preferred",
		config.DBTLSDisable: "false",
		config.DBTLSRequire: "skip-verify",
	} {
		cfg := mysql.NewConfig()
		c.TLS = mode
		if err := myTLS(cfg, c); err != nil || cfg.TLSConfig != want || cfg.TLS != nil {
			t.Errorf("%q: %q %+v %v", mode, cfg.TLSConfig, cfg.TLS, err)
		}
	}
	c.TLS = config.DBTLSVerify
	cfg := mysql.NewConfig()
	if err := myTLS(cfg, c); err != nil || cfg.TLS == nil || cfg.TLS.InsecureSkipVerify || cfg.TLS.ServerName != "db.example.com" || cfg.TLS.RootCAs != nil {
		t.Errorf("verify with the authorities of the OS: %+v %v", cfg.TLS, err)
	}
	c.TLSCA = caFile
	cfg = mysql.NewConfig()
	if err := myTLS(cfg, c); err != nil || cfg.TLS == nil || cfg.TLS.RootCAs == nil || cfg.TLS.ServerName != "db.example.com" {
		t.Errorf("verify with tls-ca: %+v %v", cfg.TLS, err)
	}
	c.TLSCA = filepath.Join(t.TempDir(), "missing.pem")
	if err := myTLS(mysql.NewConfig(), c); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a missing tls-ca: %v", err)
	}
	notPEM := filepath.Join(t.TempDir(), "x.pem")
	os.WriteFile(notPEM, []byte("not a certificate"), 0o600)
	c.TLSCA = notPEM
	if err := myTLS(mysql.NewConfig(), c); err == nil {
		t.Error("a tls-ca without a certificate was taken")
	}
	// Open says it as a failure to connect.
	c.Port = 1
	if _, err := Open(context.Background(), c, "pw"); err == nil || !strings.Contains(err.Error(), "tls-ca") {
		t.Errorf("Open with a bad tls-ca: %v", err)
	}
}
