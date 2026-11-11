package server

import (
	"os"
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
			path, err := exec.LookPath(c.sh)
			if err != nil {
				t.Skipf("%s is not installed", c.sh)
			}
			// readline の無い bash（nix の stdenv の bash など）は、プロンプトの \[ \] を解釈せず、そのまま出す
			if c.sh == "bash" && exec.Command(path, "-c", "type bind").Run() != nil {
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
			args, env := bundledShell(path, nil)
			cmd := exec.Command(path, append(args, "-i")...)
			cmd.Dir = home
			cmd.Env = append(append(os.Environ(), env...), "TERM=xterm-256color")
			ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { ptmx.Close(); cmd.Process.Kill(); cmd.Wait() }()
			var mu sync.Mutex
			go func() {
				buf := make([]byte, 65536)
				for {
					n, err := ptmx.Read(buf)
					if n > 0 {
						mu.Lock()
						em.Write(buf[:n])
						mu.Unlock()
					}
					if err != nil {
						return
					}
				}
			}()
			time.Sleep(500 * time.Millisecond)
			ptmx.WriteString("echo AGENTS-md-cmd-flake-shell-nix-go-sum-package-lock-json-rpc-vite-config-ts\n")
			time.Sleep(500 * time.Millisecond)
			count := func() int {
				mu.Lock()
				defer mu.Unlock()
				b, err := em.Serialize(1000)
				if err != nil {
					t.Fatal(err)
				}
				return strings.Count(ansi.Strip(string(b)), "PRMT-")
			}
			// 打ったコマンドの前のプロンプトと、今のプロンプトで 2 つ
			if n := count(); n != 2 {
				t.Fatalf("before resizing: %d prompts, want 2", n)
			}
			for w := cols - 5; w >= 40; w -= 5 {
				mu.Lock()
				em.Resize(rows, w)
				mu.Unlock()
				pty.Setsize(ptmx, &pty.Winsize{Rows: rows, Cols: uint16(w)})
				time.Sleep(200 * time.Millisecond)
				if n := count(); n != 2 {
					mu.Lock()
					b, _ := em.Serialize(1000)
					mu.Unlock()
					t.Fatalf("at %d columns: %d prompts, want 2\n%q", w, n, ansi.Strip(string(b)))
				}
			}
		})
	}
}
