//go:build !linux && !darwin

package server

// shellCwd はプロセス pid の cwd を読む。
func shellCwd(pid int) (string, error) { return lsofCwd(pid) }
