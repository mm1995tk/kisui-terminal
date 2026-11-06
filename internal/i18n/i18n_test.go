package i18n

import (
	"regexp"
	"strings"
	"testing"
)

func TestTablesHaveTheSameKeys(t *testing.T) {
	for k := range en {
		if _, ok := ja[k]; !ok {
			t.Errorf("key %q is missing from the Japanese table", k)
		}
	}
	for k := range ja {
		if _, ok := en[k]; !ok {
			t.Errorf("key %q is missing from the English table", k)
		}
	}
}

var verbRE = regexp.MustCompile(`%[-+# 0-9.]*[a-zA-Z]`)

// Both languages are passed the same arguments, so they must take the same
// verbs in the same order.
func TestFormatVerbsMatch(t *testing.T) {
	for k, e := range en {
		j, ok := ja[k]
		if !ok {
			continue
		}
		ev, jv := verbRE.FindAllString(e, -1), verbRE.FindAllString(j, -1)
		if strings.Join(ev, " ") != strings.Join(jv, " ") {
			t.Errorf("%s: verbs differ: en %v, ja %v", k, ev, jv)
		}
	}
}

func TestMissingKeyFallsBack(t *testing.T) {
	SetLang(Japanese)
	defer SetLang(Default)
	if T("no.such.key") != "no.such.key" {
		t.Error("a missing key must come back as itself")
	}
	if T("serve.usage") != ja["serve.usage"] {
		t.Error("the Japanese table is not selected")
	}
	SetLang("fr")
	if Lang() != English {
		t.Error("an unknown language must select English")
	}
}
