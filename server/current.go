package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/mm1995tk/kisui-terminal/internal/buildinfo"
)

// 版によらないフォルダ（current）。
//
// kisui と同梱の shj は版ごとのフォルダ（リモートなら ~/.cache/kisui-terminal/<版>/）に置かれる。
// そのフォルダをシェルの PATH や KISUI_EXE に入れると、版を上げて kisui serve が引き継いだあとも、
// 前から動いているシェルは古い版を指し続ける（環境変数はあとから変えられない）。
// そこでシェルには版によらないフォルダ <キャッシュ>/kisui-terminal/current<チャンネル>/ を渡し、
// その中の kisui と shj を、今動いている kisui serve の実行ファイルへのシンボリックリンクにする。
// serve が始まるとき（引き継いだときも）と、シェルを始めるたびに向け直す。
//
// 安全のために:
//   - フォルダは本人だけが書ける（0700）。キャッシュのフォルダ・kisui-terminal・current のどれかを
//     ほかのユーザーが書き換えられるなら使わず、今まで通り版ごとのフォルダを渡す。
//   - リンクは一時的な名前で作ってから rename で置き換える（どの時点でも、古い版か新しい版のどちらかの
//     完全なリンクがある）。
//   - リンクの先は絶対パス。

// currentLinkKisui・currentLinkShj は、版によらないフォルダの中のリンクの名前。
const (
	currentLinkKisui = "kisui"
	currentLinkShj   = "shj"
)

// executable は os.Executable（テストで差し替える）。
var executable = os.Executable

// pointCurrent は、版によらないフォルダの kisui と shj を、この kisui serve の実行ファイルと同梱の shj に
// 向け直し、そのフォルダを返す。この実行ファイルが kisui でないとき（go test・go run など）は何もせず空を返す
// （開発中に、使っている kisui-terminal のリンクを書き換えないように）。
// 同梱の shj が無ければ shj のリンクを消す（PATH のほかの shj が使われる）。
func pointCurrent() (string, error) {
	exe := kisuiExecutable()
	if exe == "" {
		return "", nil
	}
	dir, err := currentDir()
	if err != nil {
		return "", err
	}
	shj := ""
	if d := bundledShjDir(); d != "" {
		if d, err = filepath.Abs(d); err != nil {
			return "", err
		}
		shj = filepath.Join(d, "shj")
	}
	if err := setLink(dir, currentLinkShj, shj); err != nil {
		return "", err
	}
	if err := setLink(dir, currentLinkKisui, exe); err != nil {
		return "", err
	}
	return dir, nil
}

// currentDir は、版によらないフォルダを（無ければ作って）返す。ほかのユーザーが書き換えられる場所なら Err。
func currentDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(base) {
		return "", fmt.Errorf("cache dir is not absolute: %q", base)
	}
	parent := filepath.Join(base, "kisui-terminal")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", err
	}
	dir := filepath.Join(parent, "current"+buildinfo.Suffix())
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	// キャッシュのフォルダ自体はシンボリックリンクでもよい（先を見る）。root のものや、
	// /tmp のように sticky bit のあるフォルダも許す（ほかのユーザーが中の kisui-terminal を消したり差し替えたりできない）。
	if err := checkDir(base, os.Stat, true); err != nil {
		return "", err
	}
	// kisui-terminal と current は kisui が作るフォルダ。シンボリックリンクは受けつけない。
	for _, p := range []string{parent, dir} {
		if err := checkDir(p, os.Lstat, false); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// checkDir は、path が本人のフォルダで、ほかのユーザーが書けないことを確かめる。
// shared なら、root のものと、sticky bit のある（ほかのユーザーが書ける）フォルダも許す。
func checkDir(path string, stat func(string) (fs.FileInfo, error), shared bool) error {
	fi, err := stat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s: not a directory", path)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: unknown owner", path)
	}
	uid := os.Getuid()
	if int(st.Uid) != uid && !(shared && st.Uid == 0) {
		return fmt.Errorf("%s: owned by uid %d, not %d", path, st.Uid, uid)
	}
	if fi.Mode().Perm()&0o022 != 0 && !(shared && fi.Mode()&fs.ModeSticky != 0) {
		return fmt.Errorf("%s: writable by other users (%v)", path, fi.Mode().Perm())
	}
	return nil
}

// setLink は、dir/name を target へのシンボリックリンクにする。target が空ならリンクを消す。
// 同じ先を指していれば何もしない。置き換えは一時的な名前で作ってから rename するので、
// 途中で起動されても、前のリンクか新しいリンクのどちらかが見える。
func setLink(dir, name, target string) error {
	path := filepath.Join(dir, name)
	if target == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if !filepath.IsAbs(target) {
		return fmt.Errorf("link target is not absolute: %q", target)
	}
	if cur, err := os.Readlink(path); err == nil && cur == target {
		return nil
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	tmp := filepath.Join(dir, ".tmp-"+name+"-"+hex.EncodeToString(b))
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
