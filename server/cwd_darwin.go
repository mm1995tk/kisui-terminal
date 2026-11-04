package server

import (
	"syscall"
	"unsafe"
)

// cgo は使わない（CGO_ENABLED=0）。libproc の proc_pidinfo は proc_info システムコールの薄い包みなので、
// それを直接呼ぶ。失敗したら lsof に落とす。
const (
	sysProcInfo         = 336 // SYS_proc_info
	procInfoCallPidInfo = 2   // PROC_INFO_CALL_PIDINFO
	procPidVnodePathInf = 9   // PROC_PIDVNODEPATHINFO
	// struct proc_vnodepathinfo { vnode_info_path pvi_cdir; vnode_info_path pvi_rdir; }
	// vnode_info_path = vnode_info (152 バイト) + char vip_path[MAXPATHLEN=1024]
	vnodeInfoSize = 152
	maxPathLen    = 1024
)

// shellCwd はプロセス pid の cwd を読む。
func shellCwd(pid int) (string, error) {
	var buf [2 * (vnodeInfoSize + maxPathLen)]byte
	_, _, e := syscall.Syscall6(sysProcInfo, procInfoCallPidInfo, uintptr(pid), procPidVnodePathInf, 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if e == 0 {
		p := buf[vnodeInfoSize : vnodeInfoSize+maxPathLen]
		for i, c := range p {
			if c == 0 {
				if i > 0 {
					return string(p[:i]), nil
				}
				break
			}
		}
	}
	return lsofCwd(pid)
}
