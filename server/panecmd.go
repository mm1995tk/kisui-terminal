package server

// 欄の中のコマンド（kisui open など）の頼み。設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
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

// paneDirs は、ペインに渡す kisui と shj の場所。
type paneDirs struct {
	kisuiDir string // PATH に足す kisui のフォルダ。空なら足さない
	shjDir   string // PATH に足し、シェルの包みが入れ直す shj のフォルダ。空なら足さない
	kisuiExe string // KISUI_EXE（pbcopy・pbpaste が呼ぶ kisui）。空なら渡さない
}

// lookupPaneDirs は、ペインに渡す kisui と shj の場所を決める（版によらないフォルダを向け直す）。
// 版によらないフォルダ（current.go）を使えるなら、どれもそのフォルダ（版を上げたあとも今の版を起動する）。
// 使えないとき（ほかのユーザーが書き換えられる場所にあるなど）は、版ごとのフォルダ。
// 実行ファイルの名前が kisui でないとき（go test など）は、kisui のフォルダと KISUI_EXE は空。
func lookupPaneDirs() paneDirs {
	if cur, err := pointCurrent(); err == nil && cur != "" {
		return paneDirs{kisuiDir: cur, shjDir: cur, kisuiExe: filepath.Join(cur, currentLinkKisui)}
	}
	d := paneDirs{shjDir: bundledShjDir()}
	if exe := kisuiExecutable(); exe != "" {
		d.kisuiDir, d.kisuiExe = filepath.Dir(exe), exe
	}
	return d
}

// withKisuiPath は、kisui のフォルダ（d.kisuiDir）を env の PATH の先頭に足す。欄の中で kisui open を打てるように
// （Nix のように kisui が PATH に無い配り方でも）。
func withKisuiPath(env []string, d paneDirs) []string {
	if d.kisuiDir == "" {
		return env
	}
	return prependPath(env, d.kisuiDir)
}

// kisuiExecutable は、この kisui の実行ファイル（シンボリックリンクはたどる）。名前が kisui でないとき（go test など）は空。
func kisuiExecutable() string {
	exe, err := executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if filepath.Base(exe) != "kisui" {
		return ""
	}
	return exe
}

// paneCmdConn は panecmd.Request 1 つを受けて、panecmd.Reply を返す。
func (s *Server) paneCmdConn(c net.Conn, line []byte) {
	var rq panecmd.Request
	if err := json.Unmarshal(line, &rq); err != nil {
		replyPaneCmd(c, panecmd.Reply{Error: err.Error()})
		return
	}
	s.opMu.RLock() // 引き継ぎ（handover.go）の間は待つ
	if s.isHandedOver() {
		s.opMu.RUnlock()
		replyPaneCmd(c, panecmd.Reply{Error: errHandedOver.Error()})
		return
	}
	r, err := s.paneCmd(rq)
	if w, ok := errors.AsType[*updateWaiting](err); ok {
		// kisui update は GUI の答えを待つ。答え（update.result）も読みロックを取るので、待つ間は手放す
		// （引き継ぎの書きロックが待っていても詰まらないように）
		s.opMu.RUnlock()
		r, err = w.wait()
	} else {
		s.opMu.RUnlock()
	}
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
		if panecmd.HasScheme(rq.Target) { // URL は欄にせず、GUI の手元の外部ブラウザで開かせる
			id, err := s.ws.openURL(wsID, rq.Target)
			return panecmd.Reply{ID: id}, err
		}
		e, err := paneTarget(rq.Target)
		if err != nil {
			return panecmd.Reply{}, err
		}
		id, err := s.ws.addExtra(wsID, nil, e)
		return panecmd.Reply{ID: id}, err
	case "split":
		id, err := s.ws.splitFrom(wsID, rq)
		return panecmd.Reply{ID: id}, err
	case "update":
		return s.updateStart()
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

// paneTarget は kisui open の相手（URL でないもの）から欄を作る（ID は付けない）。絶対パスのファイルとして、
// 種類を拡張子か中身で決める（detectFileKind）。
func paneTarget(target string) (extraPane, error) {
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

// 名前を断る理由。cleanPaneName が返す（errors.Is で見分けられる）。
var (
	errNameTooLong = errors.New("the name is too long")
	errNameControl = errors.New("the name has a control character")
)

// cleanPaneName は kisui pane title の名前を確かめる。前後の空白は落とす。空なら名前を外す。
// 改行などの制御文字と、長すぎる名前は断る。
func cleanPaneName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxPaneName {
		return "", fmt.Errorf("%w (at most %d characters)", errNameTooLong, maxPaneName)
	}
	if strings.ContainsFunc(s, unicode.IsControl) {
		return "", errNameControl
	}
	return s, nil
}

// splitFrom は kisui pane split。rq.Pane の欄を rq.Dir に分け、新しい欄でシェルか rq.Argv を動かす。
// 分け方と最小の大きさの決まりは GUI で分けるときと同じ（planSplit）。フォルダは rq.Cwd（フォルダでなければ、打った欄の cwd）。
func (w *wsManager) splitFrom(wsID string, rq panecmd.Request) (string, error) {
	if !validSplitDir(rq.Dir) {
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
