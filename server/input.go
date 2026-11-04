package server

// 入力（input.* / command.run / file.open）。設計は docs/design/gui-protocol.md の 3 章「キー・マウス・貼り付けの入力」。
//
// 入力は要求で、受け取った順に 1 件ずつ処理する（rpc.Options.Ordered）。core に渡して反映したら、その入力の
// seq を「ここまで反映した」（Screen.AckSeq）として覚え、画面を作り直す。応答の rev は、そのあとの最新の版。
// 返事を待っている更新があるときは、入力が入った画面は screen.ack のあとに届く（ackSeq で分かる）。

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"github.com/mm1995tk/shijimi-editor/core/screen"
	"github.com/mm1995tk/shijimi-editor/ui/gui/rpc"
)

// Inputs は GUI の入力をワークスペースの core に届けるもの（cmd が core.Workspaces から渡す）。
// id はワークスペースの id。core が無ければ何もしない。
type Inputs interface {
	Key(id string, in KeyInput)
	Composition(id string, in CompositionInput)
	Mouse(id string, in MouseInput)
	Paste(id string, in PasteInput)
	Focus(id string, in FocusInput)
	// Command は ":" コマンドを実行する（制御用ソケットの exec と同じ）。
	Command(id, line string) (ok bool, message string)
	// OpenFile は id のワークスペースの core（フォルダ root）で path（絶対パス）を開き、at が nil でなければカーソルをそこに置く。
	// core が無ければ作る。開けなければ理由を返す。
	OpenFile(id, root, path string, at *screen.Pos, pane string) error
}

// KeyInput は input.key のパラメータ。
type KeyInput struct {
	Seq    uint64        `json:"seq"`
	Region screen.Region `json:"region"`
	Key    string        `json:"key"`  // W3C の KeyboardEvent.key
	Mods   []string      `json:"mods"` // "ctrl" / "shift" / "alt" / "super"
	Text   string        `json:"text,omitempty"`
	Phase  string        `json:"phase"` // "press"（省いたとき）/ "repeat" / "release"
}

// CompositionInput は input.composition のパラメータ。Cursor が nil なら変換の終わり。
type CompositionInput struct {
	Seq    uint64        `json:"seq"`
	Region screen.Region `json:"region"`
	Text   string        `json:"text"`
	Cursor *[2]int       `json:"cursor"` // [start, end]（Text の中の rune の位置）
}

// MouseInput は input.mouse のパラメータ。Row と Col は Pane の本文の中のマス目（行は lines.rows のキーと
// 同じ数え方、桁は行番号の右から）。Button は W3C の MouseEvent.button（0 が左、1 が中、2 が右）。
type MouseInput struct {
	Seq    uint64        `json:"seq"`
	Region screen.Region `json:"region"`
	Pane   string        `json:"pane,omitempty"`
	Kind   string        `json:"kind"` // "down" / "up" / "move" / "wheel"
	Button *int          `json:"button,omitempty"`
	Clicks int           `json:"clicks,omitempty"`
	Row    int           `json:"row"`
	Col    int           `json:"col"`
	Dx     int           `json:"dx,omitempty"` // wheel：横の桁数（右が正）
	Dy     int           `json:"dy,omitempty"` // wheel：行数（下が正）
	Mods   []string      `json:"mods"`
}

// PasteInput は input.paste のパラメータ。
type PasteInput struct {
	Seq    uint64        `json:"seq"`
	Region screen.Region `json:"region"`
	Text   string        `json:"text"`
}

// FocusInput は input.focus のパラメータ。
type FocusInput struct {
	Seq    uint64        `json:"seq"`
	Region screen.Region `json:"region"`
}

// inputMethods は入力のメソッド。受け取った順に 1 件ずつ処理する。
var inputMethods = []string{"input.key", "input.composition", "input.mouse", "input.paste", "input.focus", "command.run", "file.open"}

// isInputMethod は rpc.Options.Ordered。
func isInputMethod(m string) bool { return slices.Contains(inputMethods, m) }

// knownRegions は input.* の region に来てよい領域。
var knownRegions = []screen.Region{
	screen.RegionFiles, screen.RegionExplorer, screen.RegionChanges, screen.RegionAgent,
	screen.RegionTerminal, screen.RegionStatus, screen.RegionCmdline, screen.RegionOverlay,
}

// SetInputs は入力の届け先を決める。無ければ input.* は not_found を返す。
func (s *Server) SetInputs(in Inputs) {
	s.mu.Lock()
	s.inputs = in
	s.mu.Unlock()
}

func (s *Server) inputsOf() Inputs {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inputs
}

// inputHandlers は input.* のメソッドごとに、パラメータを読んで確かめ、root の core に届けて seq を返す。
var inputHandlers = map[string]func(in Inputs, root string, raw json.RawMessage) (uint64, error){
	"input.key": func(in Inputs, root string, raw json.RawMessage) (uint64, error) {
		var p KeyInput
		if err := decodeInput(raw, &p, &p.Region); err != nil {
			return 0, err
		}
		switch p.Phase {
		case "":
			p.Phase = "press"
		case "press", "repeat", "release":
		default:
			return 0, rpc.Errorf(rpc.CodeInvalidParams, "unknown phase: %s", p.Phase)
		}
		in.Key(root, p)
		return p.Seq, nil
	},
	"input.composition": func(in Inputs, root string, raw json.RawMessage) (uint64, error) {
		var p CompositionInput
		if err := decodeInput(raw, &p, &p.Region); err != nil {
			return 0, err
		}
		in.Composition(root, p)
		return p.Seq, nil
	},
	"input.mouse": func(in Inputs, root string, raw json.RawMessage) (uint64, error) {
		var p MouseInput
		if err := decodeInput(raw, &p, &p.Region); err != nil {
			return 0, err
		}
		if !slices.Contains([]string{"down", "up", "move", "wheel"}, p.Kind) {
			return 0, rpc.Errorf(rpc.CodeInvalidParams, "unknown kind: %s", p.Kind)
		}
		in.Mouse(root, p)
		return p.Seq, nil
	},
	"input.paste": func(in Inputs, root string, raw json.RawMessage) (uint64, error) {
		var p PasteInput
		if err := decodeInput(raw, &p, &p.Region); err != nil {
			return 0, err
		}
		in.Paste(root, p)
		return p.Seq, nil
	},
	"input.focus": func(in Inputs, root string, raw json.RawMessage) (uint64, error) {
		var p FocusInput
		if err := decodeInput(raw, &p, &p.Region); err != nil {
			return 0, err
		}
		in.Focus(root, p)
		return p.Seq, nil
	},
}

// inputRequest は input.* / command.run / file.open。扱わないメソッドは handled == false。
func (ss *session) inputRequest(req *rpc.Message) (res any, err error, handled bool) {
	if !isInputMethod(req.Method) {
		return nil, nil, false
	}
	if err := ss.needHello(); err != nil {
		return nil, err, true
	}
	s := ss.srv
	in := s.inputsOf()
	if in == nil {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no workspace takes input"), true
	}
	if req.Method == "file.open" {
		return ss.fileOpenReq(in, req)
	}
	root := s.ws.focusID()
	if root == "" {
		return nil, rpc.Errorf(rpc.CodeNotFound, "no workspace has the focus"), true
	}
	if req.Method == "command.run" {
		return ss.commandReq(in, root, req)
	}
	seq, err := inputHandlers[req.Method](in, root, req.Params)
	if err != nil {
		return nil, err, true
	}
	return map[string]any{"rev": ss.applied(seq)}, nil, true
}

// commandReq は command.run。
func (ss *session) commandReq(in Inputs, root string, req *rpc.Message) (any, error, bool) {
	var p struct {
		Seq  uint64 `json:"seq"`
		Line string `json:"line"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err), true
	}
	ok, msg := in.Command(root, p.Line)
	ss.applied(p.Seq)
	return map[string]any{"ok": ok, "message": msg}, nil, true
}

// decodeInput は input.* のパラメータを読み、region を確かめる。
func decodeInput(raw json.RawMessage, p any, region *screen.Region) error {
	if err := json.Unmarshal(raw, p); err != nil {
		return invalidParams(err)
	}
	if !slices.Contains(knownRegions, *region) {
		return rpc.Errorf(rpc.CodeInvalidParams, "unknown region: %s", *region)
	}
	return nil
}

// fileOpenReq は file.open。path はワークスペースのルートからの相対パス（tree.* と同じ）。
func (ss *session) fileOpenReq(in Inputs, req *rpc.Message) (any, error, bool) {
	var p struct {
		Seq         uint64 `json:"seq"`
		WorkspaceID string `json:"workspaceId"`
		Path        string `json:"path"`
		Line        *int   `json:"line"`
		Col         *int   `json:"col"`
		Pane        string `json:"pane"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, invalidParams(err), true
	}
	// 0 は先頭という正しい値なので、省いたとき（カーソルを動かさない）と分ける。
	var at *screen.Pos
	if p.Line != nil || p.Col != nil {
		at = &screen.Pos{}
		if p.Line != nil {
			at.Line = *p.Line
		}
		if p.Col != nil {
			at.Col = *p.Col
		}
		if at.Line < 0 || at.Col < 0 {
			return nil, rpc.Errorf(rpc.CodeInvalidParams, "negative line or col"), true
		}
	}
	rel, err := cleanRel(p.Path)
	if err != nil {
		return nil, err, true
	}
	if rel == "" {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "the workspace root is not a file"), true
	}
	s := ss.srv
	w := s.ws
	// workspace.focus と同じく、ワークスペースがまだあるのを確かめてから core を作る
	// （消えたあとに作った core は、誰も止めなくなる）。
	w.recomputeMu.Lock()
	root, ok := w.rootOf(p.WorkspaceID)
	if !ok {
		w.recomputeMu.Unlock()
		return nil, rpc.Errorf(rpc.CodeNotFound, "no such workspace: %s", p.WorkspaceID), true
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := checkFile(root, full, rel); err != nil {
		w.recomputeMu.Unlock()
		return nil, err, true
	}
	err = in.OpenFile(p.WorkspaceID, root, full, at, p.Pane)
	w.recomputeMu.Unlock()
	if err != nil {
		return nil, rpc.Errorf(rpc.CodeInternalError, "open %s: %v", rel, err), true
	}
	// 開いたファイルの一覧を workspace.changed に載せる。
	w.recompute()
	return map[string]any{"rev": ss.applied(p.Seq)}, nil, true
}

// checkFile は full（root の中の rel）が、root の中にあるファイルなのを確かめる。
func checkFile(root, full, rel string) error {
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return rpc.Errorf(rpc.CodeNotFound, "no such file: %s", rel)
		}
		return rpc.Errorf(rpc.CodeInternalError, "%v", err)
	}
	if !within(root, real) {
		return errDenied(rel)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return fsError(err)
	}
	if fi.IsDir() {
		return rpc.Errorf(rpc.CodeInvalidParams, "not a file: %s", rel)
	}
	return nil
}

// applied は seq の入力を反映したことを覚えて画面を作り直し、そのあとの版を返す。
func (ss *session) applied(seq uint64) int64 {
	s := ss.srv
	s.screenMu.Lock()
	vs := ss.viewOf()
	vs.ackSeq = max(vs.ackSeq, seq)
	s.screenMu.Unlock()
	s.pushScreen()
	return s.currentRev()
}
