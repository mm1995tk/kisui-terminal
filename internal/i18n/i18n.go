// Package i18n holds every user-visible string of kisui in one table per
// language (en.go, ja.go). Code asks for a string by key with T; the language
// is chosen once, from `ui-language` in kisui-terminal's config.toml (or, when it is not there, shj's),
// with SetLang.
package i18n

import "sync/atomic"

// Supported language codes.
const (
	English  = "en"
	Japanese = "ja"
)

// Default is the language used when `ui-language` is unset or unknown.
const Default = English

type selected struct {
	code  string
	table map[string]string
}

var current atomic.Pointer[selected]

func init() { SetLang(Default) }

// SetLang selects the UI language by its code ("en" or "ja"). An empty or
// unknown code selects the default, English.
func SetLang(code string) {
	if code == Japanese {
		current.Store(&selected{Japanese, ja})
		return
	}
	current.Store(&selected{English, en})
}

// Valid reports whether code names a supported language.
func Valid(code string) bool {
	return code == English || code == Japanese
}

// Lang returns the code of the language selected now.
func Lang() string { return current.Load().code }

// T returns the string for key in the selected language. A key missing from
// that table falls back to the English one, and then to the key itself.
func T(key string) string {
	if s, ok := current.Load().table[key]; ok {
		return s
	}
	if s, ok := en[key]; ok {
		return s
	}
	return key
}
