package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

func TestPrintUpdate(t *testing.T) {
	tests := []struct {
		name         string
		u            *panecmd.UpdateResult
		code         int
		out, errText string
	}{
		{"available", &panecmd.UpdateResult{Status: panecmd.UpdateAvailable, Current: "0.1.0", Version: "0.2.0"}, 0, "0.2.0", ""},
		{"latest", &panecmd.UpdateResult{Status: panecmd.UpdateLatest, Current: "0.1.0"}, 0, "up to date", ""},
		{"manual", &panecmd.UpdateResult{Status: panecmd.UpdateManual}, 0, "nix flake update", ""},
		{"failed", &panecmd.UpdateResult{Status: panecmd.UpdateFailed, Error: "offline"}, 1, "", "offline"},
		{"no answer", nil, 1, "", "no answer"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			if code := printUpdate(&out, &errOut, tt.u); code != tt.code {
				t.Errorf("code = %d, want %d", code, tt.code)
			}
			if !strings.Contains(out.String(), tt.out) || !strings.Contains(errOut.String(), tt.errText) {
				t.Errorf("out = %q, err = %q", out.String(), errOut.String())
			}
		})
	}
}
