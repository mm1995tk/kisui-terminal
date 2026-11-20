// Package dbtest starts a PostgreSQL and a MySQL server of its own for the
// tests that need a real database (internal/db, server). Each server lives in
// a temporary folder, listens only on a Unix socket there, and is stopped
// when the tests of the package end.
//
// The programs (initdb and postgres; mysqld) are looked for in PATH. The
// devShell and the go-test check of the flake have them. Where they are
// missing the test is skipped, unless KISUI_TEST_DB is set (the flake sets
// it), which makes that a failure so that the check cannot pass by skipping.
package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mm1995tk/kisui-terminal/config"
)

// The user every test logs in as, and its password. The MySQL server also
// has root with no password.
const (
	User     = "kisui"
	Password = "s3cret pass"
)

// server is one started database server.
type server struct {
	once sync.Once
	conn config.DBConnection
	err  error
	skip string // why it could not be started here
	stop func()
}

var (
	postgres, mysqlSrv server
	// stops are run by Stop.
	mu    sync.Mutex
	stops []func()
)

// Stop stops the servers. Call it from TestMain after m.Run.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	for _, f := range stops {
		f()
	}
	stops = nil
}

// Postgres returns a connection to a PostgreSQL server that asks for the
// password of User (scram-sha-256). The database is named like the user.
func Postgres(t testing.TB) config.DBConnection {
	t.Helper()
	return postgres.get(t, startPostgres)
}

// MySQL returns a connection to a MySQL server where User has Password and
// every right on the database "kisui".
func MySQL(t testing.TB) config.DBConnection {
	t.Helper()
	return mysqlSrv.get(t, startMySQL)
}

// Login is c as a person logs in to it.
func Login(c config.DBConnection) config.DBLogin {
	return c.Login(c.Access(config.DBHuman))
}

func (s *server) get(t testing.TB, start func(*server)) config.DBConnection {
	t.Helper()
	s.once.Do(func() { start(s) })
	if s.skip != "" {
		if os.Getenv("KISUI_TEST_DB") != "" {
			t.Fatalf("KISUI_TEST_DB is set, but %s", s.skip)
		}
		t.Skip(s.skip)
	}
	if s.err != nil {
		t.Fatal(s.err)
	}
	return s.conn
}

// tempDir is a short temporary folder: the path of a Unix socket may be at
// most about 100 bytes, and t.TempDir and $TMPDIR can be longer than that.
func tempDir() (string, error) {
	return os.MkdirTemp("/tmp", "kisui-db")
}

// run runs a command to its end and returns its output with the error.
func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v\n%s", name, err, out)
	}
	return nil
}

// daemon starts a server process whose output goes to logPath, and registers
// stopping it (and removing dir).
func daemon(dir, logPath, name string, args ...string) error {
	log, err := os.Create(logPath)
	if err != nil {
		return err
	}
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = log, log
	dieWithParent(cmd)
	if err := cmd.Start(); err != nil {
		log.Close()
		return err
	}
	mu.Lock()
	stops = append(stops, func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		log.Close()
		os.RemoveAll(dir)
	})
	mu.Unlock()
	return nil
}

// waitFor tries try until it works, for at most a minute. On a timeout the
// log of the server is put in the error.
func waitFor(logPath string, try func(ctx context.Context) error) error {
	deadline := time.Now().Add(time.Minute)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := try(ctx)
		cancel()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			log, _ := os.ReadFile(logPath)
			return fmt.Errorf("the server did not come up: %v\n%s", err, log)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func startPostgres(s *server) {
	for _, bin := range []string{"initdb", "postgres"} {
		if _, err := exec.LookPath(bin); err != nil {
			s.skip = bin + " is not in PATH"
			return
		}
	}
	dir, err := tempDir()
	if err != nil {
		s.err = err
		return
	}
	data, pwfile, logPath := filepath.Join(dir, "data"), filepath.Join(dir, "pw"), filepath.Join(dir, "log")
	if s.err = os.WriteFile(pwfile, []byte(Password+"\n"), 0o600); s.err != nil {
		return
	}
	if s.err = run("initdb", "-D", data, "-U", User, "--auth=scram-sha-256", "--pwfile="+pwfile, "--no-sync", "-E", "UTF8", "--locale=C"); s.err != nil {
		os.RemoveAll(dir)
		return
	}
	if s.err = daemon(dir, logPath, "postgres", "-D", data, "-k", dir, "-c", "listen_addresses=", "-c", "fsync=off"); s.err != nil {
		return
	}
	s.conn = config.DBConnection{Name: "pg", Kind: config.DBPostgres, Host: dir, Port: 5432, User: User}
	s.err = waitFor(logPath, func(ctx context.Context) error {
		cfg, err := pgconn.ParseConfig(fmt.Sprintf("host=%s port=5432 user=%s dbname=postgres", dir, User))
		if err != nil {
			return err
		}
		cfg.Password = Password
		c, err := pgconn.ConnectConfig(ctx, cfg)
		if err != nil {
			return err
		}
		defer c.Close(ctx)
		// The database a connection without `database` opens.
		_, err = c.Exec(ctx, "CREATE DATABASE "+User).ReadAll()
		return err
	})
}

func startMySQL(s *server) {
	if _, err := exec.LookPath("mysqld"); err != nil {
		s.skip = "mysqld is not in PATH"
		return
	}
	dir, err := tempDir()
	if err != nil {
		s.err = err
		return
	}
	data, sock, logPath := filepath.Join(dir, "data"), filepath.Join(dir, "sock"), filepath.Join(dir, "log")
	// --no-defaults comes first: the option files of the machine are not read.
	if s.err = run("mysqld", "--no-defaults", "--initialize-insecure", "--datadir="+data); s.err != nil {
		os.RemoveAll(dir)
		return
	}
	if s.err = daemon(dir, logPath, "mysqld", "--no-defaults", "--datadir="+data, "--socket="+sock,
		"--skip-networking", "--mysqlx=OFF", "--pid-file="+filepath.Join(dir, "pid"),
		"--innodb-flush-log-at-trx-commit=0", "--skip-log-bin"); s.err != nil {
		return
	}
	s.conn = config.DBConnection{Name: "my", Kind: config.DBMySQL, Host: sock, Port: 3306, User: User, Database: "kisui"}
	s.err = waitFor(logPath, func(ctx context.Context) error {
		cfg := mysql.NewConfig()
		cfg.User, cfg.Net, cfg.Addr = "root", "unix", sock
		cfg.Logger = &mysql.NopLogger{}
		connector, err := mysql.NewConnector(cfg)
		if err != nil {
			return err
		}
		db := sql.OpenDB(connector)
		defer db.Close()
		for _, q := range []string{
			"CREATE DATABASE IF NOT EXISTS kisui",
			fmt.Sprintf("CREATE USER IF NOT EXISTS '%s'@'localhost' IDENTIFIED BY '%s'", User, Password),
			fmt.Sprintf("GRANT ALL ON kisui.* TO '%s'@'localhost'", User),
		} {
			if _, err := db.ExecContext(ctx, q); err != nil {
				return err
			}
		}
		return nil
	})
}
