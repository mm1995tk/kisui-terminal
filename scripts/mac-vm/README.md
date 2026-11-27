# macOS の確認用 VM

macOS で kisui-terminal の版を確かめるための VM（[lume](https://github.com/trycua/cua/tree/main/libs/lume)）を、
毎回同じ状態から作るスクリプト。Firefox と拡張を毎回入れ直さずに済む。

## 使い方

```sh
npm run build:extension               # 拡張の zip を extension/dist に作る
scripts/mac-vm/new-check-vm.sh        # kisui-vm を作り直し、nightly と拡張と設定を入れる
lume attach kisui-vm                  # 画面を見る
```

- 別の Release を入れるときは `--tag v0.2.0`。
- 設定を変えるときは `--config <ファイル>`（既定はこのフォルダの `config.local.toml`）。
- `kisui-vm` は毎回消して作り直す。中に残した設定や作業は消える。
- `kisui-vm` の MAC アドレスを固定しているので、同じホストでは IP アドレスが毎回同じになる（ホストの DHCP が
  MAC アドレスごとに貸し出しを `/var/db/dhcpd_leases` に覚えているため）。何になるかはスクリプトの最後に出る。
  cua-driver の MCP（`ssh lume@<IP アドレス> /Users/lume/.local/bin/cua-driver mcp`）の接続先は、1 度合わせれば
  変えずに使える。ほかのホストで初めて動かしたときや、貸し出しの記録が消えた後は、別の IP アドレスになる。

## 3 つの VM

| VM | 中身 | 作り方 |
| --- | --- | --- |
| `kisui-vm-base` | 素の macOS。ユーザー `lume` への ssh の鍵と、`~/.local/bin/cua-driver`（画面の操作の権限を許したもの） | 手で作る |
| `kisui-vm-golden` | base に、Firefox（Developer Edition を `Firefox.app` の名前で）、署名の無い拡張を許す設定、Firefox のプロファイルを足したもの | `make-golden.sh` |
| `kisui-vm` | golden の複製に、確かめる版と拡張と設定を入れたもの | `new-check-vm.sh` |

複製は APFS の複製なので、すぐ終わり、ディスクもほとんど使わない。

## Firefox を Developer Edition にする理由

- 確かめるのは、`npm run build:extension` で手元に作った拡張（まだ addons.mozilla.org に出していない版）で、
  これには署名が無い。普通の Firefox は、署名の無い拡張を about:debugging から一時的にしか入れられず、
  Firefox を閉じると消える。
- Developer Edition は `xpinstall.signatures.required` を false にでき、プロファイルの `extensions` に置いた
  拡張を入れたままにできる。
- kisui-terminal は `open -a Firefox` で Firefox を開くので、`Firefox.app` という名前で入れる。
