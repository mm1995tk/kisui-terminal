# パスキーのログインを内蔵ブラウザに写す取り決め（kisui-terminal と拡張機能）

内蔵ブラウザ（`[gui.browser] enabled = true`）のページは OS の WebView（macOS は WKWebView、Linux は WebKitGTK）で、
iCloud キーチェーンや 1Password のパスキーを使えない（macOS は Apple の権限が要り、Linux は OS がパスキーをアプリに渡す仕組みを持たない）。
そこで、パスキーが要る場面だけ外のブラウザ（Firefox）に移ってログインし、ログインした後の Cookie を内蔵ブラウザに写して戻る。
パスキーを使わないサイトでも、ユーザーが手で始めれば、同じように外のブラウザ（1Password などの拡張機能が使える）でログインして戻れる（#276。下の「手で始める」）。

この文書は、kisui-terminal（#206。`app/src-tauri/src/passkey.rs`）と、外のブラウザに入れる拡張機能（#207。`extension/`。作りとストアに出す手順は `docs/browser-extension.md`）の間の取り決めを書く。
取り決めを変えるときは、両方を合わせて変える。

## 流れ

1. ユーザーが設定ファイルに、Cookie を写してよいサイトを書く（下の「設定」）。
2. 内蔵ブラウザのタブで、そのサイトのページが `navigator.credentials.get` か `navigator.credentials.create` でパスキー（`publicKey`）を求める。
   kisui-terminal は、ページに入れたスクリプトでそれを捕まえ、ページには `NotAllowedError` を返す。
   入力欄の候補に出すパスキー（`mediation: "conditional"`）は、ページを開いただけで求められるので、捕まえても外のブラウザに移らない。
3. kisui-terminal は、そのタブの今の URL（一番上のフレームのもの）を外のブラウザで開き、そのサイトのログインを 10 分待つ。
   移るのは、URL の host が設定のサイトの項目に当たるときだけ（下の「設定」）。待つ単位は、当たった項目（`.google.com` で当たれば `.google.com`）。
4. ユーザーが外のブラウザでパスキーでログインする。
5. 拡張機能が、そのタブの今のページに送られる Cookie を native messaging で kisui-terminal に送る（kisui-terminal が開いたタブでパスキーが通り、ページの移動と Cookie の書き換えが落ち着いたとき。または、拡張機能のボタンを押したとき。`docs/browser-extension.md`）。
6. kisui-terminal は、待っているサイトの Cookie だけを内蔵ブラウザの共有のデータに入れ、移る前のタブで同じ URL を開き直し、窓を前に出す。
   1 回受けたら待ちを終える。

シークレットのタブ（#204）では、この仕組みを使わない（写した Cookie が外のブラウザに残り、「残さない」と食い違うため）。

## 手で始める（パスキーを使わないサイト）

パスワードでログインするサイトや、パスキーを求める前に WebView を止めるサイトでは、「流れ」の 2 が起きない。
そこで、内蔵ブラウザのタブでリーダーの `o s`（#276。`docs/key-design.md`）を押すと、パスキーを待たずに「流れ」の 3 から始める
（`passkey.rs` の `start`）。

- 使えるのは、タブの今の URL が、ページがパスキーを求めたときと同じ決まりで許可サイトに当たるときだけ（Cookie を受け取ってよいサイトを広げない）。
  当たらなければ外のブラウザに移らず、理由を右下のお知らせに出す（`passkey_sites` が無いときも）。
- 待ちは、ページがパスキーを求めたときと同じもの（同じサイトを、同じ長さだけ、1 回だけ待つ）。取り決めのメッセージは変わらない。
- 外のブラウザでログインしたら、拡張機能のボタン（手で戻るボタン）を押して Cookie を送る。拡張機能は、パスキーが通ったときだけ自動で送るので、
  パスワードでのログインでは自動では送らない。手で戻るボタンは、kisui-terminal がそのサイトを待っていれば、パスキーが通ったかを問わずに送る。
- シークレットのタブでは使えない（「流れ」の終わりと同じ理由）。理由をお知らせに出す。

## 設定

GUI の設定ファイル（`~/.config/kisui-terminal/config.toml`。`config.local.toml` が上に重なる）の `[gui.browser]` に書く。

```toml
[gui.browser]
enabled = true
passkey_sites = ["github.com", "dash.cloudflare.com", ".google.com"]
```

外のブラウザは Firefox（macOS は `open -a Firefox`、Linux は `firefox`）。前の版の `passkey_browser`（移る先のブラウザを選んだ。#433 で外した）は、書いてあっても読み飛ばす。

- `passkey_sites`：host を小文字で書く（`https://`・ポート・パス・`*` は書けない）。書き方は 2 つ。
  - `github.com`：ページの host と完全に同じものだけが当たる（`github.com` は `gist.github.com` に当たらない）。
  - `.google.com`（先頭に `.`）：そのドメインとすべてのサブドメインに当たる（`google.com`・`accounts.google.com`・`myaccount.google.com`）。
    ログインの後に別のサブドメインへ移るサイト（Google は `accounts.google.com` でログインすると `myaccount.google.com` に移る）に使う。
    公開サフィックス（[Public Suffix List](https://publicsuffix.org/) にある、`.com`・`.co.jp`・`.github.io` のように誰でもその下に
    サブドメインを持てる名前。一覧に無い最上位のドメインと、`.kobe.jp` のようにすぐ下の名前がどれも公開サフィックスになる名前も含む）は書けない。他人のサイトの Cookie まで写す対象になるため。
    そう書いた項目は使わず、理由を右下のお知らせに出す（ほかの項目と設定は使う）。kisui-terminal は一覧を同梱して埋め込み、自前のコードで読む（`app/src-tauri/assets/public_suffix_list.dat` と `app/src-tauri/src/public_suffix.rs`。更新の手順は CONTRIBUTING.md）。
  - 1 つの host に 2 つ以上の項目が当たれば、host と完全に同じもの、次に `.` の後ろの長いもの（細かいもの）を使う。
    kisui-terminal（外のブラウザに移るか・待っているサイトか）と拡張機能（スクリプトを入れるサイト・手で戻るボタン・自動で送るときのサイトの比べ方）は同じ決まりで当てる。
  外のブラウザに移るのも、Cookie を受け取るのも、ここに書いたサイトだけ。
- 変えたら kisui-terminal を起動し直す（起動したときの設定を使う）。
- 書いてあれば、kisui-terminal は起動するたびに、受け口のスクリプトと登録のファイルを置き直す（下の「受け口」）。
  一覧を空にするか消して起動すると、置いた登録のファイルを消す。

## 受け口（native messaging のホスト）

- 名前：普通の版は `dev.mm1995tk.kisui_terminal`、nightly 版は `dev.mm1995tk.kisui_terminal_nightly`（アプリの identifier の、英数字と `.` 以外を `_` にしたもの）。
  拡張機能は `runtime.connectNative` か `runtime.sendNativeMessage` にこれを渡す。2 つの版を並べて入れていることがあるので、拡張機能は両方の名前に `sites` を聞き、
  そのサイトを `waiting` に挙げた方に `cookies` を送る（つなげない名前は、その版が入っていないか、サイトを書いていない）。
  版ごとに名前を分けるのは、ソケットと受け口のスクリプトが版ごとに別のデータのフォルダにあり、登録のファイルが 1 つだと互いに上書き・消去し合うため。
- 起動するもの：データのフォルダ（nightly 版は `dev.mm1995tk.kisui-terminal-nightly` のフォルダ。macOS は `~/Library/Application Support/dev.mm1995tk.kisui-terminal`、Linux は
  `~/.local/share/dev.mm1995tk.kisui-terminal`）の `passkey/native-host`。kisui-terminal 自身の実行ファイルを
  `--native-messaging-host <ソケット>` 付きで起動する sh のスクリプトで、kisui-terminal が起動するたびに書き直す（実行ファイルが動いても追う）。
- 登録のファイル（`<名前>.json`）を置く場所（Firefox の印のフォルダがあるときだけ置く）：

  | ブラウザ | macOS | Linux |
  | --- | --- | --- |
  | Firefox  | `~/Library/Application Support/Mozilla/NativeMessagingHosts/`            | `~/.mozilla/native-messaging-hosts/`（`~/.config/mozilla/` があれば `~/.config/mozilla/native-messaging-hosts/` にも） |

  Linux の `~/.config` は、`$XDG_CONFIG_HOME` が絶対パスならそれ。
  前の版（#433 より前）は、Chrome と Chromium にも登録のファイルを置いていた（macOS は `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`・`~/Library/Application Support/Chromium/NativeMessagingHosts/`、
  Linux は `~/.config/google-chrome/NativeMessagingHosts/`・`~/.config/chromium/NativeMessagingHosts/` の `<名前>.json`）。今の版はそれを消さないので、要らなければ手で消す。
  残っていると、前の版の拡張機能の id に受け口へつなぐ許可を与え続ける。
- つないでよい拡張機能：`kisui-terminal@mm1995tk.github.io`（拡張機能の `browser_specific_settings.gecko.id`。`passkey.rs` の `FIREFOX_EXTENSION_ID`）。
- 受け口は、受けたメッセージを、動いている kisui-terminal の窓に渡し、窓の答えをそのまま返す。窓が動いていなければ `not-running` を返す。

## メッセージ

native messaging の決まりどおり、1 つのメッセージは JSON 1 つ。どのメッセージにも、答えが 1 つ返る。
拡張機能から送れるのは 4 MiB まで。知らない項目は読み飛ばす。

### `sites`：許可サイトの一覧と、待っているサイト

```json
{ "type": "sites" }
```

答え：

```json
{
  "type": "sites",
  "version": 2,
  "sites": ["github.com", "dash.cloudflare.com", ".google.com"],
  "waiting": [
    { "site": ".google.com", "url": "https://accounts.google.com/v3/signin" }
  ]
}
```

- `sites`：設定の `passkey_sites`（使う項目だけ。書いた形のまま）。拡張機能は、ここにある項目に当たるページの Cookie だけを読む。
- `waiting`：kisui-terminal が外のブラウザに移って、ログインを待っているサイト（当たった項目）と、外のブラウザで開いた URL。
  拡張機能は、この URL で kisui-terminal が開いたタブを見分けられる。
- `version`：取り決めの版。項目を足すだけなら上げない。今の形と合わなくなる変更で上げる。
  2 で、`sites`・`waiting`・`cookies` の `site` に `.google.com` の書き方が入るようになった（拡張機能は 0.2.0 から読める。0.1.x（0.1.0・0.1.1）は `.google.com` の項目を扱えない）。

### `cookies`：ログインした後の Cookie

```json
{
  "type": "cookies",
  "site": "github.com",
  "cookies": [
    {
      "name": "user_session",
      "value": "…",
      "domain": "github.com",
      "hostOnly": true,
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "sameSite": "lax",
      "session": false,
      "expirationDate": 1790000000.5
    }
  ]
}
```

- `site`：`sites` の 1 つ（今のタブの host に当たる項目。`.google.com` なら、`myaccount.google.com` のタブからでも `.google.com`）。
- `cookies`：Firefox の `cookies.Cookie` をそのまま入れてよい（`storeId` などほかの項目は読み飛ばす）。
  `name`・`value`・`domain` は要る。ほかは省ける（`hostOnly`・`secure`・`httpOnly`・`session` は false、`path` は `/`）。
  `sameSite` は `no_restriction`・`lax`・`strict`（ほかの値は指定なし）。`expirationDate` は 1970 年からの秒（`session` が true なら見ない）。
  1 回に 1000 個まで。
- 拡張機能が送る Cookie：今のタブのページ（host）に送られるもの。
- kisui-terminal が入れる Cookie（`site` が `github.com` の書き方のとき）：
  - そのサイトのページに送られるものだけ（`domain` がサイトと同じか、`hostOnly` でない上のドメインのもの。`.cloudflare.com` は
    `dash.cloudflare.com` に送られる）。サイトの下のドメイン（`gist.github.com`）や、ほかのサイトのものは捨てる。
  - 入れるときは、どれもサイトの host だけの Cookie にする（上のドメインのまま入れると、許可していないサイトにも送られるため）。
- kisui-terminal が入れる Cookie（`site` が `.google.com` の書き方のとき）：
  - `google.com` とその下のドメインのものは、そのドメインのまま入れる（どれも許可した範囲）。`hostOnly` のものは host だけ、
    そうでないもの（`.google.com`）はサブドメインにも送られるまま入れる（開き直す `accounts.google.com` にも送られるように）。
  - `hostOnly` でない上のドメインのものは、`.google.com`（`google.com` とそのサブドメインに送られるもの）にする。ほかのサイトのものは捨てる。
- どちらの書き方でも：
  - 期限の切れたもの、名前や値に制御文字か `;` のあるもの、名前が空か `=` を含むもの、`path` が `/` で始まらないものは捨てる。
  - HttpOnly の Cookie も入れる。

答え（入れた）：

```json
{ "type": "done", "accepted": 12, "dropped": 3 }
```

`accepted` は入れた数、`dropped` は捨てた数。入れたあと、kisui-terminal は移る前のタブで同じ URL を開き直し、窓を前に出す。

### 断るとき

```json
{ "type": "error", "code": "not-waiting", "message": "…" }
```

| `code`        | 意味                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `bad-request` | メッセージの形が違う（JSON でない・`type` を知らない・項目の型が違う・Cookie が多すぎる）                     |
| `not-allowed` | `site` が設定の `passkey_sites` に無い                                                                        |
| `not-waiting` | そのサイトに移っていない（パスキーを求められていない・`o s` で始めていない・10 分を過ぎた・もう 1 回受けた） |
| `no-cookies`  | 入れられる Cookie が 1 つも無い（待ちは続く）                                                                 |
| `failed`      | 入れられなかった（内蔵ブラウザのタブが 1 つも開いていない、など）。待ちは終わる                               |
| `not-running` | kisui-terminal の窓が動いていない（受け口が返す）                                                             |

## 安全のための作り

Cookie をほかのプログラムに持ち出す動きは、ログイン情報を盗むマルウェアと同じ形になる。次のようにして、広げないようにする。

- 受け口から窓への経路は Unix ソケット。データのフォルダの `passkey/`（自分だけが入れる 0700 のフォルダ）に置き、ソケットも 0600 にする。
  窓は、つないだ相手のユーザー（Linux は `SO_PEERCRED`、macOS は `getpeereid`）が自分と同じでなければ、何も読まずに切る。
  ほかのユーザーは、Cookie を差し込むことも、サイトの一覧を読むこともできない。
- 窓は、自分が外のブラウザに移ったサイトの Cookie だけを、移ってから 10 分の間に 1 回だけ受ける。
  入れる Cookie は、そのサイトの host だけ（`.google.com` の書き方なら、そのドメインの中だけ）のものにする。公開サフィックスは書けない。
- 同じユーザーのほかのプログラムは、受け口を真似れば、その間に限って Cookie を差し込める。ただし、同じユーザーのプログラムは、
  もともと内蔵ブラウザの Cookie の置き場（同じユーザーのファイル）や設定ファイルを直接読み書きできるので、この経路で広がる害は無い。
- ページ（外のサイト）には Tauri の命令を開かない。ページのスクリプトは、`kisui-passkey:` の URL を `window.open` で開こうとして
  知らせるだけで（殻が受けて断る）、URL にはタブを作るたびに決める nonce を入れる。外のブラウザで開く URL はページから受け取らず、
  殻がタブの今の URL を読む。真似されても、できるのは許可サイトの今のページを外のブラウザで開くことまで（同じタブからは 3 秒に 1 回）。
- 拡張機能は、入れるときに 1 回だけ全サイトの権限をもらい、実際に読むのは `sites` の答えにあるサイトだけにする（`extension/background.js`）。

## 使えないサイトと場面

- ログインを Cookie でなく localStorage などに置くサイトでは、写せない（Cookie だけを写す）。
- Google（`.google.com`）で、Firefox から写したログインが内蔵ブラウザで続くかは、確かめていない。
  下の「Device Bound Session Credentials（DBSC）と Google」に、分かっていることと確かめていないことを分けて書く。
- 重要な操作の前に、その操作の画面の中でパスキーを求めるサイトでは、その操作は外のブラウザで行う。
  本人の確認をサーバーが覚える作り（GitHub の sudo mode）なら、外のブラウザで確認して Cookie を写したあと、内蔵ブラウザで続けられる。
- 認証アプリのコードやパスワードでのログインは、外のブラウザに移らずに内蔵ブラウザで入力できる。
  外のブラウザの 1Password などの拡張機能でパスワードを入れたいときは、リーダーの `o s` で外のブラウザに移れる（上の「手で始める」）。

## Device Bound Session Credentials（DBSC）と Google

DBSC は、ログインの Cookie を、端末の中の鍵（Windows は TPM、macOS は Secure Enclave）に結び付ける仕組み。
Cookie だけを別の端末やブラウザに持ち出しても、鍵が無いので使えなくなるように作られている。
以前の言い切り（DBSC のサイトでは写した Cookie が使えない）の根拠は Issue #206 の記述だけで、確かめた記録は無い。

分かっていること（公開の文書で確かめた。2026-11 時点）：

- Google は、DBSC を Chrome 146 の Windows で出し、macOS には「次の Chrome で広げる」と書いている（[Google のブログ](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/)）。
  このブログに、Linux と Firefox のことは書いていない。DBSC が使えない端末（安全な鍵の置き場が無い端末）でログインがどうなるかも、書いていない。
- DBSC は W3C の作業中の仕様（[W3C](https://www.w3.org/TR/dbsc/)）。
- Mozilla の標準の立場を決める場（[mozilla/standards-positions の #912](https://github.com/mozilla/standards-positions/issues/912)）で、DBSC には `position: negative` のラベルが付いている。
  2026-06-30 に Mozilla の人が negative の立場を提案し、2026-08-05 にラベルが付いて Issue は閉じられた。理由は、盗まれた Cookie を使える時間が残ること、再認証に独自の仕組みが要ること、TPM があることを前提にしたくないこと。
  同じコメントに「negative は、実装しないとは限らない」（"A negative position does not necessarily mean that we will not implement a proposal."）とある。
  Firefox が DBSC を実装したという公開の文書は、見つけられなかった。

確かめていないこと（この文書では言い切らない）：

- Firefox が今、DBSC を実装していないこと。実装していないという Firefox 側の文書（リリースノート・MDN）は読んでいない。上は「見つけられなかった」まで。
- Google が、Firefox でしたログインに DBSC の鍵を結び付けるか。結び付けないなら、写した Cookie は今までの Cookie と同じに使えるはずだが、実機で試していない。
- 内蔵ブラウザ（macOS は WKWebView、Linux は WebKitGTK）が DBSC を実装しているか、Google がそれを DBSC に対応したブラウザと見なすか。
- Google が、別の場所（IP アドレス・端末の特徴）から使われた Cookie を、DBSC と関係なく止めるか。
- `passkey_sites = [".google.com"]` で、内蔵ブラウザから Google にパスキーでログインし、Firefox でログインした後に Cookie が戻り、タブがログインした状態で開き直り、そのまま続くか（#279 で、まだ試していないと書いた）。

つまり、Google で使えるか使えないかは、どちらとも言えない。試して分かったら、Issue で知らせてほしい。
Cookie が戻ったあと、しばらくしてログインが切れるなら、DBSC か Google の別の仕組みが働いている可能性がある。
DBSC が原因なら、鍵は外のブラウザの側にあって持ち出せないので、Cookie を写す今の作りでは続かない。Google の別の仕組みが原因なら、何ができるかは、原因が分かってから考える（確かめていない）。

## 拡張機能なしで試す

受け口は、標準入力に native messaging の形（4 バイトの長さと JSON）でメッセージを渡せば動く。拡張機能が無くても、次のように送れる
（Linux の例。macOS はデータのフォルダを `~/Library/Application Support/dev.mm1995tk.kisui-terminal` に読み替える）。
先に、内蔵ブラウザで許可サイトのページを開き、パスキーを求めさせるかリーダーの `o s` を押して（外のブラウザが開く）、10 分以内に送る。

```sh
host=~/.local/share/dev.mm1995tk.kisui-terminal/passkey/native-host
send() { perl -e '$j = join "", <STDIN>; print pack("L", length $j), $j' | "$host" |
  perl -e 'while (read STDIN, $l, 4) { read STDIN, $b, unpack("L", $l); print "$b\n" }'; }
echo '{"type":"sites"}' | send
echo '{"type":"cookies","site":"github.com","cookies":[{"name":"user_session","value":"…","domain":"github.com","hostOnly":true,"secure":true,"httpOnly":true}]}' | send
```
