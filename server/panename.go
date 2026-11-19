package server

// ペインの名前と、名前か id でペインを指すこと（kisui pane。#340）。設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// 名前は 1 つの kisui serve（1 つのマシン）の中で重ならず、id（t1 など）の形もしない。だから名前か id で、そのマシンの
// ペインが 1 つに決まる（find）。重ならないことは、名前を付けるところ（setName と kisui pane split --name）で、nameMu を
// 持って確かめる。引き継ぎ（handover）で受け取った名前は確かめない（古い版が付けた名前が重なっていることがある。find が断る）。

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"slices"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// 名前を断る理由と、ペインが見つからない理由（errors.Is で見分けられる）。
var (
	errNameTaken     = errors.New("the name is already used by another pane")
	errNameLikeID    = errors.New("the name looks like the id of a pane (t and a number)")
	errNoSuchPane    = errors.New("no pane has this name or id")
	errPaneAmbiguous = errors.New("more than one pane has this name")
)

// paneIDLike はペインの id の形（term.go の start が振る "t" と番号）。名前には使えない。
var paneIDLike = regexp.MustCompile(`^t[0-9]+$`)

// checkNameLocked は、ペイン self（新しいペインなら ""）に name（cleanPaneName を通したもの）を付けてよいかを確かめる。
// 空（名前を外す）はよい。nameMu を持って呼ぶ。
func (m *termManager) checkNameLocked(name, self string) error {
	if name == "" {
		return nil
	}
	if paneIDLike.MatchString(name) {
		return fmt.Errorf("%w: %q", errNameLikeID, name)
	}
	for _, t := range m.all() {
		if t.id == self {
			continue
		}
		t.mu.Lock()
		n := t.name
		t.mu.Unlock()
		if n == name {
			return fmt.Errorf("%w (%s): %q", errNameTaken, t.id, name)
		}
	}
	return nil
}

// setName はペイン t に名前 name（cleanPaneName を通したもの）を付ける。ほかのペインの名前と重なるか、id の形なら断る。
func (m *termManager) setName(t *terminal, name string) error {
	m.nameMu.Lock()
	defer m.nameMu.Unlock()
	if err := m.checkNameLocked(name, t.id); err != nil {
		return err
	}
	t.mu.Lock()
	t.name = name
	t.mu.Unlock()
	return nil
}

// find は、名前か id が target のペインを返す。名前は付けるときに重ならないようにしているが、引き継ぎで受け取った名前は
// 重なることがあるので、2 つ以上に当たれば（名前と別のペインの id に当たるときも）断る。
// kisui pane のほかのペインを指す操作（送る・閉じる・読むなど）が使う。
func (m *termManager) find(target string) (*terminal, error) {
	var found []*terminal
	for _, t := range m.all() {
		t.mu.Lock()
		n := t.name
		t.mu.Unlock()
		if n != "" && n == target {
			found = append(found, t)
		}
	}
	if t, err := m.get(target); err == nil && !slices.Contains(found, t) {
		found = append(found, t)
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("%w: %q", errNoSuchPane, target)
	case 1:
		return found[0], nil
	}
	return nil, fmt.Errorf("%w: %q", errPaneAmbiguous, target)
}

// paneList は kisui pane list。この serve の全部のターミナル（どのワークスペースのものでも）を、ワークスペースを作った順に、
// それぞれのプライマリターミナルを先にして返す。self は頼んだターミナル。
func (s *Server) paneList(self string) []panecmd.PaneInfo {
	type tab struct {
		seq  int
		name string
	}
	tabs := map[string]tab{}
	s.ws.mu.Lock()
	for id, st := range s.ws.reg {
		name := st.label
		if name == "" && st.root != "" {
			name = filepath.Base(st.root)
		}
		tabs[id] = tab{seq: st.seq, name: name}
	}
	s.ws.mu.Unlock()
	out := []panecmd.PaneInfo{}
	for _, t := range s.terms.all() {
		t.mu.Lock()
		p := panecmd.PaneInfo{ID: t.id, Name: t.name, Tab: t.wsID, Cwd: t.cwd, Title: t.title, Primary: t.primary, Alive: t.alive, Self: t.id == self}
		t.mu.Unlock()
		p.TabName = tabs[p.Tab].name
		out = append(out, p)
	}
	seq := func(p panecmd.PaneInfo) int {
		if x, ok := tabs[p.Tab]; ok {
			return x.seq
		}
		return math.MaxInt // ワークスペースの無いターミナルは最後に
	}
	slices.SortFunc(out, func(a, b panecmd.PaneInfo) int {
		if c := cmp.Compare(seq(a), seq(b)); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Tab, b.Tab); c != 0 {
			return c
		}
		if a.Primary != b.Primary {
			if a.Primary {
				return -1
			}
			return 1
		}
		return termIDNum(a.ID) - termIDNum(b.ID)
	})
	return out
}
