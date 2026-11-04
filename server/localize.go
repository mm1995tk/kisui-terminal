package server

import (
	"reflect"

	"github.com/mm1995tk/shijimi-editor/core/i18n"
	"github.com/mm1995tk/shijimi-editor/core/msg"
)

// The core and screen.Screen hold every message as a msg.Msg (an i18n key and
// its values). The GUI protocol carries the Msg itself (see msg.Msg.MarshalJSON)
// and the GUI translates it with the table from i18n.get; only the TUI and the
// few places where the core needs words (Text) translate here.

// Text is core.Port's: m in the language of this process.
func (s *Server) Text(m msg.Msg) string { return i18n.Text(m) }

// SetLanguage is core.Port's: the config of a core picked a language, and the
// process translates with it. A GUI that has the table is sent the new one.
func (s *Server) SetLanguage(code string) {
	i18n.SetLang(code)
	s.ScreenChanged()
}

// I18n is the result of i18n.get and the body of i18n.changed: the language and
// every string in it (English fills what the language lacks).
type I18n struct {
	Lang     string            `json:"lang"`
	Messages map[string]string `json:"messages"`
}

func currentI18n() I18n { return I18n{Lang: i18n.Lang(), Messages: i18n.Table()} }

func (ss *session) i18nReq() (any, error, bool) {
	t := currentI18n()
	s := ss.srv
	s.screenMu.Lock()
	ss.viewOf().i18n = &t
	s.screenMu.Unlock()
	return t, nil, true
}

// pushI18n sends i18n.changed when the language differs from what the GUI was
// given. It goes before the screen, as theme.changed does.
func (s *Server) pushI18n(ss *session, vs *viewState) {
	if vs.i18n == nil {
		return
	}
	t := currentI18n()
	if reflect.DeepEqual(t, *vs.i18n) {
		return
	}
	vs.i18n = &t
	_ = ss.conn.Notify("i18n.changed", t)
}
