package main

import (
	"os/exec"
	"strings"
	"testing"
)

// kisui-terminal and shijimi-editor share no code: they meet only through the
// agreement in docs/protocol.md (the types are copied, in internal/ctl). A
// Go dependency on shijimi-editor would tie the two versions together again.
func TestNoDependencyOnShijimiEditor(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}}", "../...").Output()
	if err != nil {
		t.Skipf("go list: %v", err)
	}
	for dep := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(dep, "github.com/mm1995tk/shijimi-editor") {
			t.Errorf("kisui-terminal imports %s", dep)
		}
	}
}
