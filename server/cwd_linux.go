package server

import (
	"os"
	"strconv"
)

// shellCwd はプロセス pid の cwd を読む。
func shellCwd(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}
