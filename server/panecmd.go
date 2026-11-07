package server

// 欄の中のコマンド（kisui open など）の頼み。設計は docs/design/gui-protocol.md の「欄の中のコマンド」。
//
// kisui serve は、始めるどのターミナルにも、serve-primary.rpc の場所・ターミナルの id・そのターミナルだけの秘密を
// 環境変数で渡す（panecmd）。コマンドは serve-primary.rpc に 1 行の panecmd.Request を送り、1 行の panecmd.Reply を受ける。
// shj の行（docs/protocol.md）とは、cmd があるかで分ける。ソケットは 0700 のディレクトリの中なので、ほかのユーザーは
// つなげない。同じユーザーでも、欄の外で始まったプロセスは秘密を知らないので断られる。

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// newPaneToken はターミナルの秘密（128 ビットの乱数を 16 進で）。
func newPaneToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// withKisuiPath は、この kisui の実行ファイルのあるフォルダを env の PATH の先頭に足す。欄の中で kisui open を打てるように。
// 実行ファイルの名前が kisui でないとき（go test など）と、同梱の shj と同じフォルダのときは足さない。
func withKisuiPath(env []string) []string {
	exe, err := os.Executable()
	if err != nil {
		return env
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	dir := filepath.Dir(exe)
	if filepath.Base(exe) != "kisui" || dir == bundledShjDir() { // 同梱の shj と同じフォルダなら、bundledShell が足す
		return env
	}
	return prependPath(env, dir)
}

// paneCmdConn は panecmd.Request 1 つを受けて、panecmd.Reply を返す。
func (s *Server) paneCmdConn(c net.Conn, line []byte) {
	var rq panecmd.Request
	if err := json.Unmarshal(line, &rq); err != nil {
		replyPaneCmd(c, panecmd.Reply{Error: err.Error()})
		return
	}
	s.opMu.RLock() // 引き継ぎ（handover.go）の間は待つ
	defer s.opMu.RUnlock()
	if s.isHandedOver() {
		replyPaneCmd(c, panecmd.Reply{Error: errHandedOver.Error()})
		return
	}
	r, err := s.paneCmd(rq)
	if err != nil {
		r = panecmd.Reply{Error: err.Error()}
		if errors.Is(err, errNotAPane) {
			r.Code = panecmd.CodeNotInPane
		}
	}
	replyPaneCmd(c, r)
}

func replyPaneCmd(c net.Conn, r panecmd.Reply) {
	r.OK = r.Error == ""
	b, _ := json.Marshal(r)
	_, _ = c.Write(append(b, '\n'))
}

// errNotAPane は、頼んだのがこの serve のターミナルの中でない（id か秘密が合わない）とき。
var errNotAPane = errors.New("not in a pane of this kisui-terminal")

// paneCmd は rq を行う。rq の id と秘密が、生きているこの serve のターミナルのものでなければ断る。
func (s *Server) paneCmd(rq panecmd.Request) (panecmd.Reply, error) {
	t, err := s.terms.get(rq.Pane)
	if err != nil {
		return panecmd.Reply{}, errNotAPane
	}
	t.mu.Lock()
	token, wsID, alive := t.token, t.wsID, t.alive
	t.mu.Unlock()
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(rq.Token)) != 1 || !alive || wsID == "" {
		return panecmd.Reply{}, errNotAPane
	}
	switch rq.Cmd {
	case "open":
		e, err := paneTarget(rq.Target)
		if err != nil {
			return panecmd.Reply{}, err
		}
		id, err := s.ws.addExtra(wsID, nil, e)
		return panecmd.Reply{ID: id}, err
	case "split":
		id, err := s.ws.splitFrom(wsID, rq)
		return panecmd.Reply{ID: id}, err
	case "title":
		name, err := cleanPaneName(rq.Title)
		if err != nil {
			return panecmd.Reply{}, err
		}
		t.mu.Lock()
		t.name = name
		t.mu.Unlock()
		s.ws.recompute() // workspace.changed で GUI に届く
		return panecmd.Reply{ID: t.id}, nil
	}
	return panecmd.Reply{}, fmt.Errorf("unknown command: %q", rq.Cmd)
}

// paneTarget は kisui open の相手から欄を作る（ID は付けない）。URL の形（panecmd.HasScheme）なら http か https だけをブラウザで、
// 残りは絶対パスのファイルとして、種類を拡張子か中身で決める（detectFileKind）。
func paneTarget(target string) (extraPane, error) {
	if panecmd.HasScheme(target) {
		u, err := parseBrowserURL(target)
		if err != nil {
			return extraPane{}, err
		}
		return extraPane{Kind: "browser", URL: u}, nil
	}
	if !filepath.IsAbs(target) {
		return extraPane{}, fmt.Errorf("not an absolute path: %s", target)
	}
	fi, err := statRegular(target)
	if err != nil {
		return extraPane{}, err
	}
	kind, mime := detectFileKind(target)
	if kind == "" {
		return extraPane{}, fmt.Errorf("kisui cannot show this kind of file (it shows videos, images and PDFs): %s", target)
	}
	return fileExtra(kind, target, mime, fi)
}

// maxPaneName は欄の名前の長さの上限（文字数）。
const maxPaneName = 100

// cleanPaneName は kisui pane title の名前を確かめる。前後の空白は落とす。空なら名前を外す。
// 改行などの制御文字と、長すぎる名前は断る。
func cleanPaneName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxPaneName {
		return "", fmt.Errorf("the name is too long (at most %d characters)", maxPaneName)
	}
	if strings.ContainsFunc(s, unicode.IsControl) {
		return "", errors.New("the name has a control character")
	}
	return s, nil
}

// splitFrom は kisui pane split。rq.Pane の欄を rq.Dir に分け、新しい欄でシェルか rq.Argv を動かす。
// 分け方と最小の大きさの決まりは GUI で分けるときと同じ（planSplit）。フォルダは rq.Cwd（フォルダでなければ、打った欄の cwd）。
func (w *wsManager) splitFrom(wsID string, rq panecmd.Request) (string, error) {
	if rq.Dir != dirRight && rq.Dir != dirDown {
		return "", fmt.Errorf("%w: %q", errBadDir, rq.Dir)
	}
	env, err := validEnv(rq.Env)
	if err != nil {
		return "", err
	}
	if len(rq.Argv) > 0 && !filepath.IsAbs(rq.Argv[0]) {
		return "", fmt.Errorf("not an absolute path: %s", rq.Argv[0])
	}
	for _, a := range rq.Argv {
		if strings.ContainsRune(a, 0) {
			return "", errors.New("the command has a NUL character")
		}
	}
	dir := ""
	if fi, err := os.Stat(rq.Cwd); rq.Cwd != "" && err == nil && fi.IsDir() {
		dir = rq.Cwd
	} else if t, err := w.srv.terms.get(rq.Pane); err == nil {
		t.mu.Lock()
		dir = t.cwd
		t.mu.Unlock()
	}
	if dir == "" {
		var ok bool
		if dir, ok = w.folderOf(wsID); !ok {
			return "", fmt.Errorf("%w: %s", errNoWorkspace, wsID)
		}
	}
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	target, sdir, err := w.planSplit(wsID, rq.Pane, rq.Dir)
	if err != nil {
		return "", err
	}
	t, err := w.srv.terms.start(termStart{cols: 80, rows: 24, dir: dir, env: env, wsID: wsID, argv: rq.Argv})
	if err != nil {
		return "", err
	}
	w.placePane(wsID, target, sdir, t.id)
	w.recomputeLocked() // workspace.changed が先に届くので、GUI は欄を知っている
	w.srv.notifyOwner("pane.show", map[string]any{"workspaceId": wsID, "termId": t.id})
	return t.id, nil
}
