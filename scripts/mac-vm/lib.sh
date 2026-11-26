# shellcheck shell=bash
# new-check-vm.sh と make-golden.sh が source する、lume の VM を扱う関数。

# VM の状態（stopped・running など）。VM が無ければ missing。
vm_status() { lume get "$1" --format json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d)["status"])' 2>/dev/null || echo missing; }

# VM の IP アドレス。まだ無ければ空。
vm_ip() { lume get "$1" --format json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d).get("ipAddress") or "")' 2>/dev/null || true; }

# 作り直した VM は前の VM と鍵が同じとは限らないので、この手元の VM に限って known_hosts を使わない
VM_SSH_OPTS=(-T -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

# VM（$1）に ssh でつながるまで待ち、IP アドレスを出す。5 分待ってもつながらなければ失敗する。
wait_ssh() {
  local ip
  for _ in $(seq 1 60); do
    ip=$(vm_ip "$1")
    if [ -n "$ip" ] && ssh "${VM_SSH_OPTS[@]}" -o ConnectTimeout=5 "lume@$ip" true 2>/dev/null; then
      echo "$ip"
      return 0
    fi
    sleep 5
  done
  echo "$1 に ssh でつながりません。" >&2
  return 1
}
