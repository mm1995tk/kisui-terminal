package server

import (
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/creack/pty"

	"github.com/mm1995tk/kisui-terminal/internal/emulator"
)

// 本物のシェルが動く欄の幅を少しずつ狭めても、プロンプトの切れ端が残らないこと
// （mm1995tk/kisui-terminal#97）。kisui が出す OSC 133 の印で、coneko-term は幅が変わるときにプロンプトの行を
// 組み直さず、シェルの描き直しに任せる。
func TestShellResizeKeepsPromptOnce(t *testing.T) {
	cases := []struct{ sh, rcFile, rc string }{
		// 1 行目が欄より長い、2 行のプロンプト
		{"zsh", ".zshrc", "PROMPT=$'PRMT-" + strings.Repeat("x", 110) + "\\n❯ '\n"},
		{"bash", ".bashrc", "PS1='PRMT-" + strings.Repeat("x", 110) + "\\n❯ '\n"},
	}
	for _, c := range cases {
		t.Run(c.sh, func(t *testing.T) {
			// readline の無い bash（nix の stdenv の bash など）は、プロンプトの \[ \] を解釈せず、そのまま出す
			if path, err := exec.LookPath(c.sh); err == nil && c.sh == "bash" && exec.Command(path, "-c", "type bind").Run() != nil {
				t.Skip("this bash has no readline")
			}
			home, _, _ := setupShellTest(t)
			writeFile(t, filepath.Join(home, c.rcFile), c.rc)
			const rows, cols = 24, 100
			em, err := emulator.New(rows, cols)
			if err != nil {
				t.Fatal(err)
			}
			defer em.Close()
			var mu sync.Mutex
			s := startPTYShell(t, c.sh, home, rows, cols, func(p []byte) {
				mu.Lock()
				defer mu.Unlock()
				em.Write(p)
			})
			count := func() int {
				mu.Lock()
				defer mu.Unlock()
				b, err := em.Serialize(1000)
				if err != nil {
					t.Fatal(err)
				}
				return strings.Count(ansi.Strip(string(b)), "PRMT-")
			}
			s.waitFor("the first prompt", func(out string) bool { return strings.Contains(out, "\x1b]133;B\a") })
			s.settle(100 * time.Millisecond)
			s.ptmx.WriteString("echo AGENTS-md-cmd-flake-shell-nix-go-sum-package-lock-json-rpc-vite-config-ts\n")
			// コマンドが終わり（D）、次のプロンプトが出る
			s.waitFor("the second prompt", func(out string) bool {
				_, after, ok := strings.Cut(out, "\x1b]133;D;0\a")
				return ok && strings.Contains(after, "\x1b]133;B\a")
			})
			s.settle(100 * time.Millisecond)
			// 打ったコマンドの前のプロンプトと、今のプロンプトで 2 つ
			if n := count(); n != 2 {
				t.Fatalf("before resizing: %d prompts, want 2\n%q", n, s.output())
			}
			for w := cols - 5; w >= 40; w -= 5 {
				before := len(s.output())
				mu.Lock()
				em.Resize(rows, w)
				mu.Unlock()
				pty.Setsize(s.ptmx, &pty.Winsize{Rows: rows, Cols: uint16(w)})
				// シェルが描き直し終えるのを待つ（SIGWINCH を受けると、何か出力する）
				s.waitFor("the redraw", func(out string) bool { return len(out) > before })
				s.settle(100 * time.Millisecond)
				if n := count(); n != 2 {
					t.Fatalf("at %d columns: %d prompts, want 2", w, n)
				}
			}
		})
	}
}
