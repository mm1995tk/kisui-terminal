# パスキーのログインを内蔵ブラウザに写す取り決め（kisui-terminal と拡張機能）

内蔵ブラウザ（`[gui.browser] enabled = true`）のページは OS の WebView（macOS は WKWebView、Linux は WebKitGTK）で、
iCloud キーチェーンや 1Password のパスキーを使えない（macOS は Apple の権限が要り、Linux は OS がパスキーをアプリに渡す仕組みを持たない）。
そこで、パスキーが要る場面だけ外のブラウザ（Chrome か Firefox）に移ってログインし、ログインした後の Cookie を内蔵ブラウザに写して戻る。
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
passkey_browser = "chrome"   # chrome（既定。無ければ Chromium）か firefox
```

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
- 登録のファイル（`<名前>.json`）を置く場所（そのブラウザの印のフォルダがあるときだけ置く）：

  | ブラウザ | macOS                                                                    | Linux                                                                                                   |
  | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
  | Chrome   | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`      | `~/.config/google-chrome/NativeMessagingHosts/`                                                         |
  | Chromium | `~/Library/Application Support/Chromium/NativeMessagingHosts/`           | `~/.config/chromium/NativeMessagingHosts/`                                                              |
  | Firefox  | `~/Library/Application Support/Mozilla/NativeMessagingHosts/`            | `~/.mozilla/native-messaging-hosts/`（`~/.config/mozilla/` があれば `~/.config/mozilla/native-messaging-hosts/` にも） |

  Linux の `~/.config` は、`$XDG_CONFIG_HOME` が絶対パスならそれ。
- つないでよい拡張機能：Firefox は `kisui-terminal@mm1995tk.github.io`（拡張機能の `browser_specific_settings.gecko.id`）。
  Chrome は、Chrome ウェブストアのアイテム ID `ljfmfmfcicodilhhbmhkfkgjbcpphjel`（`passkey.rs` の `CHROME_EXTENSION_IDS`。`docs/browser-extension.md` の「ストアに出す」）。
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
- `cookies`：Chrome と Firefox の `cookies.Cookie` をそのまま入れてよい（`storeId` などほかの項目は読み飛ばす）。
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
- Device Bound Session Credentials でログインを端末（ブラウザ）に結び付けるサイト（Google など）では、写した Cookie が使えない。
- 重要な操作の前に、その操作の画面の中でパスキーを求めるサイトでは、その操作は外のブラウザで行う。
  本人の確認をサーバーが覚える作り（GitHub の sudo mode）なら、外のブラウザで確認して Cookie を写したあと、内蔵ブラウザで続けられる。
- 認証アプリのコードやパスワードでのログインは、外のブラウザに移らずに内蔵ブラウザで入力できる。
  外のブラウザの 1Password などの拡張機能でパスワードを入れたいときは、リーダーの `o s` で外のブラウザに移れる（上の「手で始める」）。

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
