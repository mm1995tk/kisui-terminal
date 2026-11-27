// docs/glossary.md の「Avoid」の列にある語（用語集の語に直した別名）が、
// 文書・日本語の画面の文・コードのコメントに戻っていないことを確かめる。
// 用語集そのものと、このテストのファイルは対象にしない。
package glossary

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode"
)

const glossaryPath = "docs/glossary.md"

var (
	selfPath   = "internal/glossary/avoid_test.go"
	targetExt  = regexp.MustCompile(`\.(md|ts|tsx|go|rs|css)$`)
	skipDirs   = map[string]bool{".git": true, "node_modules": true, "target": true, "dist": true, ".direnv": true, "result": true}
	noteInside = regexp.MustCompile(`[()]`)
)

// root はリポジトリの根（このファイルの 2 つ上）。
func root(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// splitCell は Avoid の列を「, 」で分ける（丸かっこの中の「, 」では分けない）。
func splitCell(cell string) []string {
	var out []string
	depth, start := 0, 0
	flush := func(end int) {
		if s := strings.TrimSpace(cell[start:end]); s != "" {
			out = append(out, s)
		}
	}
	for i, r := range cell {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				flush(i)
				start = i + 1
			}
		}
	}
	flush(len(cell))
	return out
}

// watched は見張る語か。
//   - ASCII だけの語（window など）は、OS の語としても使うので見張らない。
//   - かっこの注釈が付いた語（「(when it means …)」）は、文脈で意味が変わるので見張らない。
//   - 片仮名だけの語（ダイアログ・ワークスペースなど。「の」と空白は無視）は、日本語の文で残してよいので見張らない。
func watched(w string) bool {
	if noteInside.MatchString(w) {
		return false
	}
	for _, r := range w {
		if r == 'の' || unicode.IsSpace(r) {
			continue
		}
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) {
			return true
		}
	}
	return false
}

func avoidWords(t *testing.T, dir string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, glossaryPath))
	if err != nil {
		t.Fatal(err)
	}
	var words []string
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "|") {
			continue
		}
		// | Term | Means | Avoid |  → 「|」で分けると 5 つ（先頭と末尾は空）
		cells := strings.Split(line, "|")
		if len(cells) != 5 {
			continue
		}
		for _, w := range splitCell(cells[3]) {
			if watched(w) && !slices.Contains(words, w) {
				words = append(words, w)
			}
		}
	}
	return words
}

// targets は調べるファイル（根からの相対パス）。git の管理下ならその一覧、そうでなければ（Nix のビルドの中など）歩いて集める。
func targets(t *testing.T, dir string) []string {
	t.Helper()
	var files []string
	cmd := exec.Command("git", "ls-files")
	cmd.Dir = dir
	if out, err := cmd.Output(); err == nil {
		files = strings.Fields(string(out))
	} else {
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if skipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			rel, err := filepath.Rel(dir, p)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(rel))
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	var out []string
	for _, f := range files {
		if targetExt.MatchString(f) && f != glossaryPath && f != selfPath {
			out = append(out, f)
		}
	}
	return out
}

func TestAvoidWordsDoNotReturn(t *testing.T) {
	dir := root(t)
	words := avoidWords(t, dir)
	for _, w := range []string{"窓", "近道", "下の段", "お知らせ"} {
		if !slices.Contains(words, w) {
			t.Fatalf("見張る語に %s が無い（用語集の表を読めていない）: %v", w, words)
		}
	}
	files := targets(t, dir)
	if len(files) < 100 {
		t.Fatalf("調べるファイルが少なすぎる（%d）", len(files))
	}
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			continue // git の一覧にあって、手元で消してあるファイル
		}
		for i, line := range strings.Split(string(b), "\n") {
			for _, w := range words {
				if strings.Contains(line, w) {
					t.Errorf("%s:%d: 「%s」は用語集の Avoid の列の語。用語集の語に直す（docs/glossary.md）", f, i+1, w)
				}
			}
		}
	}
}
