// scripts/gopls-fix.sh が当てる修正が、今の gopls でも出るかを確かめるための見本。
// 1 つの関数が 1 つの題に当たる。scripts/gopls-fix.sh はこのファイルを書き換えない。
package sample

import (
	"fmt"
	"net"
	"strings"
)

func WriteString(sb *strings.Builder, a, b string) { sb.WriteString(a + b) }

func Appendf(n int) []byte { return []byte(fmt.Sprintf("%d", n)) }

func Tagged(x int) int {
	switch {
	case x == 1:
		return 1
	case x == 2:
		return 2
	}
	return 0
}

func CutLast(s string) string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}

func Clip(s []int) []int { return append(s[:len(s):len(s)], 1) }

func FieldNames() net.TCPAddr { return net.TCPAddr{nil, 80, ""} }
