package server

// ワークスペースの一覧の保存と復元（#450。設計は docs/design/gui-protocol.md の「ワークスペース」9）。
//
// 保存するのは、ワークスペースの id・フォルダ（未定なら無し）・つけた名前（あれば）・並び順だけ。分割したターミナルと
// 開いていたファイルは保存しない。ワークスペースが変わるたび（recompute のたび）に、前に書いた内容と
// 違えば書く。起動のときに読み、同じ id でワークスペースを作り直す。

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const stateVersion = 1

// StatePath は workspaces.json の場所（serve.log と同じフォルダ）。
func StatePath() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "workspaces.json"), nil
}

type savedWS struct {
	ID     string `json:"id"`
	Folder string `json:"folder,omitempty"` // 未定なら省く
	// Label はユーザーがつけた名前（workspace.rename）。つけていなければ省く。
	// 足した項目で、版は上げない（名前をつけていない保存は、前の形と同じ内容）
	Label string `json:"label,omitempty"`
}

type savedState struct {
	Version    int       `json:"version"`
	Workspaces []savedWS `json:"workspaces"` // 作った順
}

// persist は今のワークスペースの一覧を StatePath に書く。前に書いたのと同じなら書かない。
// 復元の途中は書かない（途中の一覧で上書きして、残りを失わないため）。
func (w *wsManager) persist() {
	path := w.srv.opts.StatePath
	if path == "" {
		return
	}
	w.mu.Lock()
	if w.restoring {
		w.mu.Unlock()
		return
	}
	sts := make([]*wsState, 0, len(w.reg))
	for _, st := range w.reg {
		sts = append(sts, st)
	}
	out := savedState{Version: stateVersion, Workspaces: []savedWS{}}
	sortStates(sts)
	for _, st := range sts {
		out.Workspaces = append(out.Workspaces, savedWS{ID: st.id, Folder: st.root, Label: st.label})
	}
	w.mu.Unlock()
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return
	}
	data = append(data, '\n')
	if bytes.Equal(data, w.saved) {
		return
	}
	if err := writeFileAtomic(path, data); err != nil {
		w.srv.log.Warn("save workspaces", "path", path, "err", err)
		return
	}
	w.saved = data
}

func sortStates(l []*wsState) {
	for i := 1; i < len(l); i++ {
		for j := i; j > 0 && l[j].seq < l[j-1].seq; j-- {
			l[j], l[j-1] = l[j-1], l[j]
		}
	}
}

// writeFileAtomic は同じフォルダの一時ファイルに書いてから置き換える（書きかけを残さない）。
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".workspaces-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}

// loadState は保存したワークスペースの一覧を読む。ファイルが無ければ空。
// 読めない・形が違うときは err（呼び出し側はログに書いて、戻さずに起動する）。
func loadState(path string) ([]savedWS, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var st savedState
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&st); err != nil {
		return nil, err
	}
	if st.Version != stateVersion {
		return nil, errors.New("unsupported version")
	}
	seen := map[string]bool{}
	for _, x := range st.Workspaces {
		if x.ID == "" || seen[x.ID] || (x.Folder != "" && !filepath.IsAbs(x.Folder)) {
			return nil, errors.New("invalid workspace entry")
		}
		seen[x.ID] = true
	}
	return st.Workspaces, nil
}

// restore は保存していたワークスペースを同じ id で作り直す。Serve が接続を受ける前に 1 回だけ呼ぶ。
// プライマリターミナルは、保存したフォルダ（もう無ければフォルダ未定として start_dir）で始める。
func (w *wsManager) restore() {
	path := w.srv.opts.StatePath
	if path == "" {
		return
	}
	list, err := loadState(path)
	if err != nil {
		w.srv.log.Warn("workspaces file is not read; starting without workspaces", "path", path, "err", err)
		return
	}
	if len(list) == 0 {
		return
	}
	w.recomputeMu.Lock()
	defer w.recomputeMu.Unlock()
	w.mu.Lock()
	w.restoring = true
	w.mu.Unlock()
	for _, x := range list {
		dir := x.Folder
		if dir != "" {
			if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
				w.srv.log.Warn("workspace folder is gone; restored without a folder", "workspace", x.ID, "folder", dir)
				dir = ""
			}
		}
		if dir == "" {
			dir = w.startDir()
		}
		label, err := cleanPaneName(x.Label)
		if err != nil {
			w.srv.log.Warn("workspace name is invalid; restored without a name", "workspace", x.ID, "err", err)
			label = ""
		}
		if _, _, err := w.createLocked(x.ID, dir, label); err != nil {
			w.srv.log.Warn("restore workspace", "workspace", x.ID, "err", err)
		}
	}
	w.mu.Lock()
	w.restoring = false
	w.mu.Unlock()
	w.persist()
}
