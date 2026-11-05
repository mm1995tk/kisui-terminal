package server

import (
	"path/filepath"
	"strings"
)

// Cores is the editing state of the workspaces: a core per workspace, named by
// the workspace id (core.Workspaces, handed over by cmd). The
// server decides which workspaces there are and which folder each one has; the
// cores keep the files each one has open, also while another workspace has the
// focus (docs/design/gui-protocol.md, 3 章「ワークスペース」). Two workspaces on
// the same folder have a core each.
type Cores interface {
	// Open makes sure the workspace id has a core on the folder root.
	// workspace.focus calls it. It fails when the workspace's configuration
	// files have mistakes: there is no core then.
	Open(id, root string) error
	// Files is the absolute paths of the files open in id's core.
	Files(id string) []string
	// SaveAll saves every file of id's core that has unsaved edits and returns
	// the paths it could not save. The files stay open.
	SaveAll(id string) (failed []string)
	// Release is what a workspace does with its files when its folder switches:
	// it saves them at once or throws the edits away, as the configuration says
	// ([editor.auto-save] on-switch while auto-save is off), closes them and
	// stops the core. Open makes a core on the new folder.
	Release(id string)
	// Renamed moves the open files of every core that were on from (or under it,
	// when from is a folder) to to, after tree.rename renamed it on disk.
	Renamed(from, to string)
	// Close stops id's core, with whatever is open in it, when the workspace is
	// closed (its files were saved by then).
	Close(id string)
}

// SetCores sets where the workspaces' files live. Without it the workspaces
// have no files.
func (s *Server) SetCores(c Cores) {
	s.mu.Lock()
	s.cores = c
	s.mu.Unlock()
}

func (s *Server) coresOf() Cores {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cores
}

// relFiles makes the paths relative to root ("/"-separated) when inside it.
func relFiles(root string, paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if r, err := filepath.Rel(root, p); err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			p = filepath.ToSlash(r)
		}
		out = append(out, p)
	}
	return out
}
