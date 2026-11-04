package server

// tree.watch / tree.changed。GUI が開いているフォルダだけを、一定の間隔で見る（core/watch.go と同じ作り）。
// フォルダごとに「中身の署名」（名前・種類・大きさ・更新時刻）を持ち、変わったら tree.changed を送る。

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type treeWatcher struct {
	m  *treeManager
	mu sync.Mutex
	// 通知の順を保つため、署名の更新と送信を 1 つずつにする。
	run sync.Mutex
	ws  map[string]map[string]string // workspaceId -> 相対パス -> 署名
}

func newTreeWatcher(m *treeManager) *treeWatcher {
	return &treeWatcher{m: m, ws: map[string]map[string]string{}}
}

// dirSig はフォルダの中身の署名。読めなければ "gone"。
func dirSig(abs string) string {
	ents, err := os.ReadDir(abs)
	if err != nil {
		return "gone"
	}
	h := sha256.New()
	for _, de := range ents {
		if hiddenName(de.Name()) {
			continue
		}
		var size, mt int64
		// フォルダの大きさと更新時刻は、中の変化で動くので入れない（それは中のフォルダを見ている側が知る）。
		if fi, err := de.Info(); err == nil && !de.IsDir() {
			size, mt = fi.Size(), fi.ModTime().UnixNano()
		}
		fmt.Fprintf(h, "%s\x00%d\x00%d\x00%d\n", de.Name(), de.Type(), size, mt)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// set は tree.watch。監視するフォルダを paths に置き換える。新しく入ったものは今の署名を基準にする（通知しない）。
func (w *treeWatcher) set(id, root string, paths []string) (any, error) {
	next := map[string]string{}
	abs := map[string]string{}
	for _, p := range paths {
		rel, err := cleanRel(p)
		if err != nil {
			return nil, err
		}
		a, err := resolveDir(root, rel)
		if err != nil {
			return nil, err
		}
		abs[rel] = a
	}
	w.run.Lock()
	defer w.run.Unlock()
	w.mu.Lock()
	old := w.ws[id]
	w.mu.Unlock()
	for rel, a := range abs {
		if s, ok := old[rel]; ok {
			next[rel] = s
		} else {
			next[rel] = dirSig(a)
		}
	}
	w.mu.Lock()
	if len(next) == 0 {
		delete(w.ws, id)
	} else {
		w.ws[id] = next
	}
	w.mu.Unlock()
	return struct{}{}, nil
}

// scan は監視している全フォルダを見て、変わったものを workspace ごとにまとめて通知する。
func (w *treeWatcher) scan() {
	w.mu.Lock()
	ids := make([]string, 0, len(w.ws))
	for id := range w.ws {
		ids = append(ids, id)
	}
	w.mu.Unlock()
	for _, id := range ids {
		root, ok := w.m.srv.ws.rootOf(id)
		if !ok {
			w.mu.Lock()
			delete(w.ws, id)
			w.mu.Unlock()
			continue
		}
		w.refresh(id, root, nil)
	}
}

// refresh は id の監視フォルダの署名を取り直し、変わったものを tree.changed にする。
// only が空でなければ、そのフォルダ（相対パス）だけを見る。
func (w *treeWatcher) refresh(id, root string, only []string) {
	only = slices.Collect(func(yield func(string) bool) {
		for _, o := range only {
			if !yield(normRel(o)) {
				return
			}
		}
	})
	w.run.Lock()
	defer w.run.Unlock()
	w.mu.Lock()
	cur := w.ws[id]
	rels := make([]string, 0, len(cur))
	for rel := range cur {
		if len(only) == 0 || slices.Contains(only, normRel(rel)) {
			rels = append(rels, rel)
		}
	}
	w.mu.Unlock()
	var changed []string
	sigs := map[string]string{}
	for _, rel := range rels {
		s := dirSig(filepath.Join(root, filepath.FromSlash(rel)))
		sigs[rel] = s
	}
	w.mu.Lock()
	m := w.ws[id]
	for rel, s := range sigs {
		if old, ok := m[rel]; ok && old != s {
			m[rel] = s
			changed = append(changed, rel)
		}
	}
	w.mu.Unlock()
	if len(changed) == 0 {
		return
	}
	slices.Sort(changed)
	w.m.srv.notifyOwner("tree.changed", map[string]any{"workspaceId": id, "paths": changed, "rev": w.m.rev.Add(1)})
}

// normRel は path.Dir の "." をルート（""）にそろえる。
func normRel(rel string) string {
	if rel == "." {
		return ""
	}
	return rel
}

// watch は Options.TreeInterval（既定 1 秒）ごとにフォルダを、GitInterval（既定 3 秒）ごとに git の印を見る。
func (m *treeManager) watch(done <-chan struct{}) {
	ti, gi := m.srv.opts.TreeInterval, m.srv.opts.GitInterval
	if ti <= 0 {
		ti = time.Second
	}
	if gi <= 0 {
		gi = 3 * time.Second
	}
	tt, gt := time.NewTicker(ti), time.NewTicker(gi)
	defer tt.Stop()
	defer gt.Stop()
	for {
		select {
		case <-done:
			return
		case <-tt.C:
			m.w.scan()
		case <-gt.C:
			m.g.scan()
		}
	}
}

// invalidate は id の監視フォルダすべてを「変わった」ことにして tree.changed を送る（.gitignore の変化で "!" が動いたとき）。
func (w *treeWatcher) invalidate(id string) {
	w.mu.Lock()
	var paths []string
	for rel := range w.ws[id] {
		paths = append(paths, rel)
	}
	w.mu.Unlock()
	if len(paths) == 0 {
		return
	}
	slices.Sort(paths)
	w.m.srv.notifyOwner("tree.changed", map[string]any{"workspaceId": id, "paths": paths, "rev": w.m.rev.Add(1)})
}
