package server

// ペインの中のコマンドが届くペインの範囲（kisui pane send・keys・read・close・list）。設計は docs/design/gui-protocol.md の
// 「ペインの中のコマンド」。
//
// 既定では、ペインは「自分」と「自分が作ったペイン、そのペインが作ったペイン…」にだけ届く。人が窓で開いたペインや、
// ほかのペインが作ったペインには届かない。ペインの中のプログラムは、そのマシンの利用者として動くが、ほかのペインは
// それより強い立場のこと（root のシェル、別のマシンへの ssh）をしていることがある。そこへ字を打てる・その画面を読める道を、
// 作った側のペインにだけ残す。[server] pane_reach = "all" で、そのマシンの全部のペインに届くように戻せる。
//
// 「作った」は、kisui pane split・kisui pane open（--machine で別のマシンに開いたものも）と、プライマリの shj が
// 端末のコマンドで足したペイン。作ったペインの系譜（作った側をさかのぼった並び）は、作るときに決めてターミナルが持つ
// （途中のペインが閉じても変わらない）。別のマシンのペインは、その serve の serverId で見分ける。

import (
	"errors"
	"fmt"
	"slices"
)

// paneOrigin は、ペイン 1 つを、マシンをまたいで見分ける名前。
type paneOrigin struct {
	// Server は、そのペインの serve の serverId。空なら、この serve
	Server string `json:"server,omitempty"`
	// Pane は、その serve でのターミナルの id
	Pane string `json:"pane"`
}

// maxLineage は、受け取る系譜の長さの上限（窓から届く workspace.create の ancestry）。超えた分は古いほうから捨てる。
const maxLineage = 64

// localOrigin は o を、この serve から見た形にする（この serve の serverId は空にする）。
func (s *Server) localOrigin(o paneOrigin) paneOrigin {
	if o.Server == s.serverID {
		o.Server = ""
	}
	return o
}

// lineage は、ターミナル t が作るペインに持たせる系譜（t の系譜に t を足したもの）。外に渡す形で、この serve のペインには
// serverId を付ける（別のマシンの serve が、どのマシンのペインかを見分けられるように）。
func (s *Server) lineage(t *terminal) []paneOrigin {
	out := make([]paneOrigin, 0, len(t.ancestors)+1)
	for _, o := range t.ancestors {
		if o.Server == "" {
			o.Server = s.serverID
		}
		out = append(out, o)
	}
	return append(out, paneOrigin{Server: s.serverID, Pane: t.id})
}

// adoptLineage は、受け取った系譜を、ターミナルが持つ形（この serve のペインは Server が空）にする。
// 形の合わないものは捨て、長すぎれば新しいほう（作った側に近いほう）を残す。
func (s *Server) adoptLineage(in []paneOrigin) []paneOrigin {
	var out []paneOrigin
	for _, o := range in {
		if o.Pane == "" || len(o.Pane) > 64 || len(o.Server) > 128 {
			continue
		}
		out = append(out, s.localOrigin(o))
	}
	if len(out) > maxLineage {
		out = out[len(out)-maxLineage:]
	}
	return out
}

// paneReachAll は、ペインの中のコマンドが、このマシンの全部のペインに届いてよいか（[server] pane_reach = "all"）。
// 設定は使うたびに読み直す（Options.PaneReachAll。serve を止めずに効く）。読めなければ、届かないほうに倒す。
func (s *Server) paneReachAll() bool {
	return s.opts.PaneReachAll != nil && s.opts.PaneReachAll()
}

// canReach は、caller のペインの中のコマンドが、ターミナル t に届いてよいか。caller が t 自身か、t の系譜にあるとき。
func (s *Server) canReach(caller paneOrigin, t *terminal) bool {
	if s.paneReachAll() {
		return true
	}
	caller = s.localOrigin(caller)
	if caller.Pane == "" {
		return false
	}
	if caller.Server == "" && caller.Pane == t.id {
		return true
	}
	return slices.Contains(t.ancestors, caller)
}

// childAncestors は、ターミナル t が作るペインが持つ系譜（t の系譜に t を足したもの。この serve から見た形）。
func (s *Server) childAncestors(t *terminal) []paneOrigin {
	return s.adoptLineage(s.lineage(t))
}

// primaryAncestors は、ワークスペース wsID のプライマリターミナルが作るペインが持つ系譜。プライマリの shj が端末のコマンドで
// 足すペインに持たせる（shj はプライマリターミナルの中で動く）。プライマリが無ければ空。
func (s *Server) primaryAncestors(wsID string) []paneOrigin {
	for _, t := range s.terms.all() {
		t.mu.Lock()
		ok := t.wsID == wsID && t.primary
		t.mu.Unlock()
		if ok {
			return s.childAncestors(t)
		}
	}
	return nil
}

// reachable は、caller のペインの中のコマンドが名前か id で指したペイン target を引く。届いてよいペインだけを返す。
// 全部のペインに届いてよい設定でなければ、無いペインと届かないペインを同じ文で断る（届かないペインがあるかを教えない）。
func (s *Server) reachable(caller paneOrigin, target string) (*terminal, error) {
	t, err := s.terms.find(target)
	if s.paneReachAll() {
		return t, err
	}
	if err != nil || !s.canReach(caller, t) {
		return nil, fmt.Errorf("%w: %q", errPaneOutOfReach, target)
	}
	return t, nil
}

// errPaneOutOfReach は、指したペインが、頼んだペインの届く範囲に無いとき（そういうペインが無いときも）。
var errPaneOutOfReach = errors.New(`no such pane among the panes this pane opened (kisui pane reaches this pane and the panes opened from it; [server] pane_reach = "all" in the config of this machine lets it reach every pane)`)
