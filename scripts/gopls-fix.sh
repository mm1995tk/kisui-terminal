#!/usr/bin/env bash
# gopls が出す quickfix のうち、意味を変えない書き換えだけを、全部の .go に当てる。scripts/tidy.sh から呼ぶ。
#
# go fix が当てるのは Go 本体の検査だけで、gopls 独自の検査（writestring など）と
# gopls に入っている staticcheck の検査の修正は当てない。それをここで当てる。
#
# 当てるのは TITLES に挙げた書き換えだけ。使われていない関数・変数を消す修正、引数を消す・名前を変える修正、
# 宣言を足す修正は当てない。gopls は動いている OS の build tag でしか見ないので、
# 例えば macOS でだけ使う関数を「使われていない」と言って消してしまう。
#
# staticcheck の QF1012（WriteString(fmt.Sprintf(...)) → fmt.Fprintf）も当てない。gopls 0.24 の修正は
# fmt.Sprintf(f, args...) の ... を落とし、出力を変えてしまう。
#
# gopls codeaction -exec は 1 回に 1 つしか当てないので、ファイルごとに、当てるものが無くなるまで繰り返す。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export CGO_ENABLED=0

# gopls が出す quickfix の題。gopls の版を上げて題が変わったら、ここも直す
TITLES='^(Split into separate WriteString calls' # gopls writestring: WriteString(a + b) → 2 回の WriteString
TITLES+='|Replace \[\]byte\(fmt\.Sprint'         # fmtappendf: []byte(fmt.Sprintf(...)) → fmt.Appendf
TITLES+='|Replace with tagged switch'             # staticcheck: switch { case x == 1: } や if/else の連なり → switch x { case 1: }
TITLES+='|Simplify .* using strings\.Cut'         # strings.Index などを strings.Cut に
TITLES+='|Replace with slices\.Clip'              # s[:len(s):len(s)] → slices.Clip(s)
TITLES+='|Add field names to struct literal'      # vet composites: 別パッケージの構造体の値にフィールド名を付ける
TITLES+=')'
export TITLES

fix_file() {
	local out
	# 当てるものが無くなるまで。題の合う修正が無限に出続けたときのために、上限を置く
	for _ in $(seq 100); do
		# 当てるものが無いと、gopls は "no matching code action" と言って 0 以外で終わる。それは終わりの合図
		if ! out=$(gopls codeaction -kind=quickfix -title="$TITLES" -exec -write -list "$1" 2>&1); then
			case "$out" in
			*"no matching code action"*) return 0 ;;
			*)
				echo "$out" >&2
				return 1
				;;
			esac
		fi
		[ -n "$out" ] || return 0
	done
	echo "gopls-fix: $1 の修正が終わりません" >&2
	return 1
}
export -f fix_file

# ファイルの中だけを書き換える修正なので、ファイルごとに並べて動かせる
git ls-files -z '*.go' | xargs -0 -P "$(getconf _NPROCESSORS_ONLN)" -I{} bash -c 'fix_file "$1"' _ {}
