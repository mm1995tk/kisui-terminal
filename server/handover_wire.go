package server

// 引き継ぎの socketpair の上の読み書き（1 通は 4 バイトの長さ + JSON。fd は SCM_RIGHTS）。

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
)

func writeFrame(c net.Conn, m handoverMsg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(b)))
	if _, err := c.Write(n[:]); err != nil {
		return err
	}
	_, err = c.Write(b)
	return err
}

func readFrame(c net.Conn, m *handoverMsg) error {
	var n [4]byte
	if _, err := io.ReadFull(c, n[:]); err != nil {
		return err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > maxHandoverFrame {
		return fmt.Errorf("handover message too large: %d", size)
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(c, b); err != nil {
		return err
	}
	return json.Unmarshal(b, m)
}

// sendFDs は fds を fdBatch ずつ送る。1 回は 1 バイト（その回の数）に SCM_RIGHTS を付けたもの。
func sendFDs(c *net.UnixConn, fds []int) error {
	for len(fds) > 0 {
		n := min(len(fds), fdBatch)
		if _, _, err := c.WriteMsgUnix([]byte{byte(n)}, syscall.UnixRights(fds[:n]...), nil); err != nil {
			return err
		}
		fds = fds[n:]
	}
	return nil
}

// recvFDs は sendFDs が送った n 個の fd を受ける。受けた fd は close-on-exec（net が付ける）。
func recvFDs(c *net.UnixConn, n int) ([]int, error) {
	var out []int
	buf := make([]byte, 1)
	oob := make([]byte, syscall.CmsgSpace(fdBatch*4))
	for len(out) < n {
		read, oobn, flags, _, err := c.ReadMsgUnix(buf, oob)
		if err == nil && read == 0 {
			err = io.ErrUnexpectedEOF // ストリームの ReadMsgUnix は、相手が閉じても EOF を返さない
		}
		if err != nil {
			closeFDs(out)
			return nil, err
		}
		msgs, err := syscall.ParseSocketControlMessage(oob[:oobn])
		if err != nil {
			closeFDs(out)
			return nil, err
		}
		var got []int
		for i := range msgs {
			fds, err := syscall.ParseUnixRights(&msgs[i])
			if err == nil {
				got = append(got, fds...)
			}
		}
		out = append(out, got...)
		if flags&syscall.MSG_CTRUNC != 0 || len(got) != int(buf[0]) {
			closeFDs(out)
			return nil, errors.New("file descriptors were cut off")
		}
	}
	return out, nil
}

func closeFDs(fds []int) {
	for _, fd := range fds {
		syscall.Close(fd)
	}
}
