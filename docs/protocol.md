# kisui-terminal と shj の通信の取り決め

kisui-terminal（`kisui`）と、欄の中で動く shj は、版がずれることがある。この文書は、2 つのアプリのあいだの通信の取り決めと、その版の決まりを定める。2 つのアプリ専用の取り決めで、一般的な API ではない。機能は遠慮なく足してよい。

プロトコル専用のリポジトリは作らない。取り決めは持ち主の側に文書として置く（shj → kisui の持ち主は kisui-terminal なので、この文書はここにある。kisui → shj の側は shijimi-editor の `docs/design/kisui-shj-protocol.md`）。Go の型を共有するための別のパッケージも作らない。型は両方が自分の側に持ち、取り決めだけでつながる。

## 2 本の取り決めと持ち主

| 向き | 内容 | 持ち主 | 版 |
| --- | --- | --- | --- |
| shj → kisui | プライマリの欄で名乗る `PrimaryHello` / `PrimaryReply`、開いているファイルと差分モードの変更の一覧（`diff`）を知らせる `PrimaryFile`（`PrimaryReply` の `changes` で、kisui が一覧を出せると shj に知らせる。#19）、欄を開く `PaneRequest` / `PaneReply`（`op: "explorer"` で GUI のファイルエクスプローラにフォーカスを頼む。#14）、環境変数 `SHIJIMI_GUI_PRIMARY` / `SHIJIMI_GUI_WORKSPACE`、ソケット `serve-primary.rpc` | kisui-terminal | あり（下） |
| kisui → shj | shj の操作用のソケット（`GUILinkPath` のリンク先）に送る命令（サイドバーの CHANGES で選んだファイルの差分は、既にある `{cmd: "diff", path}`。#19） | shijimi-editor | なし |

型と定数は、kisui の側が `internal/ctl/ctl.go`、shj の側が shijimi-editor の `core/ctl/ctl.go`（同じ内容の写し）。欄を開く `op: "open"` の `kind` は `"video"`・`"image"`・`"pdf"`（`path` は絶対パスのファイル。拡張子と大きさの上限は kisui が決める）と `"browser"`（`url`）。`image` と `pdf` は #15 で足した（項目の値の追加なので版は上げない。知らない `kind` を断る古い kisui には、shj が「開けない」と状態行に出す）。差分モードの変更の一覧（`PrimaryFile.diff`、`PrimaryReply.changes`）は #19 で足した（これも項目の追加だけなので版は上げない。新しい shj が古い kisui に当たったときは、`changes` が返事に無いので、shj が自分の左に CHANGES を出す）。詳しい動きは [design/gui-protocol.md](design/gui-protocol.md) の「プライマリの shj」。

## shj → kisui の版

- shj は `PrimaryHello` の `protocol` に、自分が話す版（`ctl.PrimaryProtocol`）を入れる。今は 1。
- `kisui` は受ける版の範囲（`server.MinPrimaryProtocol` 〜 `server.MaxPrimaryProtocol`）を持つ。今は 0〜1。
- **版のない `PrimaryHello`（この版より前の shj）は版 0 として受ける。**
- 範囲の外なら、`kisui` は名乗りを断る。返事は `{ok: false, error, code: "version", min, max}`（`min`・`max` は `kisui` が受ける範囲）。`ok: false` で接続を閉じるのは、ほかの断り方と同じ。
- 断られた shj は、プライマリでない欄の shj と同じに動く（ツリーを出し、欄は内蔵のターミナルを使う）。状態行に「kisui-terminal と shj の版が合わない」と出す（`gui.protocol`）。
- 古い `kisui` は知らない項目を無視するので、新しい shj の名乗りは版を見ずに受けられる。そのため、版の範囲で守れるのは「新しい `kisui` が古い shj を断る」向きと「新しい shj が、範囲を知っている `kisui` に断られる」向きに限る。

### 版を上げる決まり

- 項目を足すだけなら上げない。受け取る側は、知らない項目を無視する。足した項目を相手が知らなくても動くようにする。
- 項目の意味を変える、または消すときだけ上げる。上げたら、`kisui` が受ける範囲（Min / Max）を決めて、その版の違いをこの文書に残す。
- 版は shj 側の `ctl.PrimaryProtocol` と、`kisui` 側の範囲の上限（`MaxPrimaryProtocol`）を同時に見直す。

## kisui → shj

shj の一般の操作の仕組み（skill や herdr の連携も使う）なので、shijimi-editor が持ち主で、今は版を付けない。足すのは新しい命令（`cmd`）で、知らない命令は shj がエラーで返す。意味を変える・消す必要が出たら、そのときに版を足す。

## 版の履歴

| 版 | 内容 |
| --- | --- |
| 0 | 版のない名乗り。`PrimaryHello` は `termId`・`socket`・`pid` |
| 1 | `PrimaryHello` に `protocol` を足した。`PrimaryReply` に `code`・`min`・`max` を足した（項目の追加だけで、意味は 0 と同じ） |
