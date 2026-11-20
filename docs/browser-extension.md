# 外のブラウザの拡張機能（パスキーのログインを kisui-terminal に戻す）

内蔵ブラウザでパスキーが要るとき、kisui-terminal は同じ URL を Chrome か Firefox で開く（`docs/passkey-extension.md`）。
この拡張機能は、そのブラウザでパスキーのログインが済んだら、そのサイトの Cookie を native messaging で kisui-terminal に送り、タブを閉じる。
コードは `extension/`。Chrome と Firefox で同じコードを使い、違うのは `manifest.json` だけ（`extension/build.mjs` が作り分ける）。

## 動き

1. kisui-terminal の受け口（普通の版と nightly 版の 2 つの名前）に `sites` を聞き、許可サイト（kisui-terminal の設定の `passkey_sites`）の
   ページにだけ、`page.js`（ページの中。MAIN world）と `relay.js`（拡張機能の側）を入れる（`scripting.registerContentScripts`）。
   `.google.com` の書き方の項目は `https://*.google.com/*`（`google.com` とすべてのサブドメイン）に入れる。
   聞き直すのは、ブラウザの起動・拡張機能を入れたとき・新しいタブが許可サイトを開いたとき・一覧が 1 分より古いとき。
   どの受け口も答えなければ（kisui-terminal が動いていない）、入れたスクリプトはそのままにする。
2. kisui-terminal が開いたタブを見分ける：できてから 30 秒のうちに、kisui-terminal がログインを待っているサイト（`sites` の答えの
   `waiting`）のページを最初に開いたタブを、kisui-terminal が開いたものと見る。サイトが最初にリダイレクトしても見分けられるよう、
   URL でなくサイト（host が当たる `passkey_sites` の項目。当て方は `docs/passkey-extension.md` の「設定」で、kisui-terminal と同じ）で比べる。ブラウザが動いていなかったとき（kisui-terminal がブラウザを URL 付きで起動した）は、拡張機能が
   動き出す前にタブができているので、起動したときに `waiting` の URL と同じページを開いているタブを探す。
   タブを覚えたら、そのタブの今のページにも `page.js` と `relay.js` を入れる（一覧に足したばかりのサイトでは、登録が 1 ページ目の読み込みに間に合わないため）。
   一覧は 1 分のあいだ聞き直さないことがある（kisui-terminal が答えなかったときも）ので、`passkey_sites` を変えて kisui-terminal を起動し直した直後と、
   ブラウザを開いてから kisui-terminal が 1 回も答えていない（kisui-terminal を起動した直後）ときは、自動で戻らないことがある。そのときは手で戻るボタンを使う。
3. そのタブで `navigator.credentials.get` か `create` がパスキー（`publicKey`）で成功すると、`page.js` が知らせる（資格情報そのものは渡さない）。
4. 落ち着くのを待つ：パスキーが通ってから 2 秒は待ち、そのあと、タブの読み込みが済み、そのサイトに送られる Cookie が 1.5 秒変わらなければ
   落ち着いたと見る。15 秒を過ぎたら、落ち着かなくても送る。そのときタブが別のサイトに移っていれば送らない（手で戻るボタンを使う）。
   サイトは待っている項目で比べるので、`.google.com` で待っていれば、`accounts.google.com` から `myaccount.google.com` に移っていても送る。
5. 今のタブのページに送られる Cookie だけを読み（`cookies.getAll` を、タブの host の URL と、その host のドメインで。タブの Cookie の置き場から）、
   取り決めの `cookies` で、その項目を `waiting` に挙げた受け口に送る。`done` が返ったらタブを閉じる。断られたら、拡張機能のボタンに
   `!` を付け、ボタンの説明（マウスを乗せると出る）に理由を書く。
6. 手で戻るボタン（拡張機能のボタン）：パスキーの後にまだ手順が続くサイトのため。押すと、今のタブの host が許可サイトの項目に当たり、kisui-terminal が
   その項目を待っていれば、今のタブのページに送られる Cookie を送り、タブを閉じる（`.google.com` で待っていれば、`myaccount.google.com` のタブからも送れる）。キーは、Chrome は `chrome://extensions/shortcuts`、Firefox は
   アドオンの管理の「拡張機能のショートカットキーの管理」で付けられる（既定では付けない。ブラウザやページのキーとぶつけないため）。

Cookie を読むのは、kisui-terminal の答えの `sites` にある項目に当たるページのものだけ。そのほかのサイトの Cookie・閲覧の履歴は読まない。
`page.js` は許可サイトのすべてのタブに入るが、知らせを使うのは kisui-terminal が開いたタブ（と、手で押したボタン）だけ。

## 権限

| 権限                            | 使うところ                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cookies`                       | 許可サイトの Cookie（HttpOnly のものも）を読む                                                     |
| `nativeMessaging`               | kisui-terminal の受け口とやり取りする                                                              |
| `scripting`                     | 許可サイトのページに、パスキーが通ったことを知る小さなスクリプトを入れる                           |
| `storage`                       | kisui-terminal が開いたタブと許可サイトの一覧を、ブラウザを閉じるまで覚える（`storage.session`）   |
| `https://*/*`（host の権限）    | 許可サイトは利用者が kisui-terminal の設定で決めるので、どのサイトでも読めるよう入れるときに 1 回だけもらう |
| `http://*/*`（host の権限）     | Secure の付かない Cookie（Google の `SID` など）を読む。Chrome（Chromium）は、https のサイトの Cookie でも、Secure の付かないものは `http://` の host の権限が無いと拡張機能に渡さない（Issue #286 で確かめた）。Firefox で要るかは確かめていない（入れた形で読めることは確かめた） |

Firefox は、入れるときに host の権限を断れる。断ったときは、拡張機能のボタンを押すと頼み直す。
版を上げて host の権限が増えたとき（0.1.1 の `http://*/*`）も、更新で新しい権限をもらえていなければ、パスキーの後に自動で送る道は
権限を確かめないので、足りない Cookie を欠いたまま送る。そのときも、拡張機能のボタンを 1 回押すと頼み直す。
更新で権限がもらえるかは確かめていないので、出し直す前に 0.1.0 からの更新で確かめる。

## 作る・試す

```sh
npm run test:extension     # テスト（nix flake check の checks.extension も同じもの）
npm run typecheck:extension # JSDoc の型の検査（tsc -p extension。npm test にも入っている。web-test の check が回す）
npm run build:extension    # extension/dist/ に chrome/・firefox/ と、ストアに上げる 2 つの zip を作る
nix build .#kisui-terminal-extension   # 同じものを Nix で作る（result/ に出る）
```

zip は、同じソースからは同じバイト列になる（中のファイルの順と時刻を固定している）。

手で入れて試す：

- Firefox：`about:debugging#/runtime/this-firefox` の「一時的なアドオンを読み込む」で `extension/dist/firefox/manifest.json` を選ぶ
  （Firefox を閉じると外れる。署名の無い拡張機能を残しておけるのは Developer Edition・Nightly・ESR だけ）。
  id（`kisui-terminal@mm1995tk.github.io`）が決まっているので、kisui-terminal の受け口にそのままつながる。
- Chrome：`chrome://extensions` でデベロッパー モードを入れ、「パッケージ化されていない拡張機能を読み込む」で `extension/dist/chrome/` を選ぶ。
  `extension/build.mjs` の `CHROME_PUBLIC_KEY` にストアの公開鍵を入れてあるので、パッケージ化されていない `chrome/` もストアと同じ id
  （`ljfmfmfcicodilhhbmhkfkgjbcpphjel`）になり、受け口がつないでよい Chrome の拡張機能の id（`app/src-tauri/src/passkey.rs` の `CHROME_EXTENSION_IDS`）
  に合うので、kisui-terminal の受け口にそのままつながる。

## ストアに出す（オーナーの作業）

ストアのアカウントの登録・提出・公開は、オーナーのアカウントで行う。このリポジトリが用意するのは、上げる zip と、下の説明文・権限の理由・
プライバシーの説明まで。

公開しているのは addons.mozilla.org だけ（https://addons.mozilla.org/addon/kisui-terminal-passkey-login/ ）。
Chrome ウェブストアには出さないことにした（Issue #207）。Chrome では、上の「手で入れて試す」の形で読み込む。
下の「1. Chrome ウェブストア」は、id と公開鍵を決めたときの記録として残す。

### 1. Chrome ウェブストア：下書きを作り、id を決める（審査には出さない）

1. Chrome Web Store の開発者として登録する（https://chrome.google.com/webstore/devconsole 。登録料は 1 回だけ 5 ドル）。
2. `npm run build:extension` で作った `extension/dist/kisui-terminal-chrome-<版>.zip` を「新しいアイテム」として上げる（まだ審査に出さない）。
3. アイテムの id（ダッシュボードの「アイテム ID」。32 文字の a〜p）と、「パッケージ」の「公開鍵を表示」の公開鍵
   （`-----BEGIN PUBLIC KEY-----` と `-----END PUBLIC KEY-----` の間を 1 行にしたもの）を控える。公開鍵は秘密の値ではない。
4. この 2 つをリポジトリに入れる PR を作る（Issue にコメントすれば作業役が作れる）：
   - `app/src-tauri/src/passkey.rs` の `CHROME_EXTENSION_IDS` に id を足す（これで kisui-terminal は Chrome と Chromium にも受け口の登録のファイルを置く）。
   - `extension/build.mjs` の `CHROME_PUBLIC_KEY` に公開鍵を入れる（手で入れて試す `chrome/` の id がストアと同じになる）。
     公開鍵から計算した id が `CHROME_EXTENSION_IDS` と同じことは、`npm run test:extension` が確かめる。

   済み：id は `ljfmfmfcicodilhhbmhkfkgjbcpphjel`（Issue #207）。

### 2. addons.mozilla.org（AMO）

1. https://addons.mozilla.org/developers/ に Firefox アカウントでログインし、開発者の同意をする（登録料は無い）。
2. 「新しいアドオンを提出」で「このサイトで公開する」を選び、`extension/dist/kisui-terminal-firefox-<版>.zip` を上げる。
   id は manifest の `kisui-terminal@mm1995tk.github.io` に決まっている（AMO は id を付けない）。
3. ソースコードの提出を聞かれたら「いいえ」：zip の中の JavaScript は `extension/` のファイルそのもの（まとめも縮めもしていない）。
   `manifest.json` だけを `extension/build.mjs` が作る。
4. 下の「ストアの説明」と「プライバシー」を入れ、審査に出す。

済み：版 0.1.0 が自動の審査を通り、公開された（2026-11-18）。

### 版を上げるとき

`extension/manifest.json` の `version` を上げて zip を作り直し、addons.mozilla.org に上げる。kisui-terminal の版とは別に数える。
0.2.0 で、`passkey_sites` の `.google.com` の書き方（取り決めの版 2）を読めるようにした（#279）。
取り決め（`docs/passkey-extension.md`）を変えるときは、kisui-terminal と拡張機能を合わせて変える。

### ストアの説明

名前と短い説明は `extension/_locales/{en,ja}/messages.json` の `extensionName` と `extensionDescription`（ストアは manifest から読む）。

下の詳しい説明とプライバシーの欄は、パスワードでのログイン（#276。kisui-terminal のリーダーの `o s`）も含めた案に直してある。審査に出したあとに直したので、ストアへの反映は公開の後にオーナーが行う（拡張機能そのものは変えていないので、版は上げない）。

詳しい説明（English）：

> kisui-terminal is a terminal-centered workspace with a built-in browser. The built-in browser is the WebView of the OS, so it cannot use the passkeys of iCloud Keychain or 1Password, nor browser extensions such as 1Password. When a page there asks for a passkey, kisui-terminal opens the same page in this browser instead. You can also move a site to this browser yourself from kisui-terminal, to log in with a password (for example with the 1Password extension).
>
> This extension finishes the round trip: after you log in with your passkey here, it sends the cookies of that site to kisui-terminal on the same computer (through native messaging), closes the tab, and kisui-terminal reloads its tab, logged in. When you log in with a password, or the site asks for more steps after the passkey, press the extension's button when you are done.
>
> It reads cookies only of the sites you list in the kisui-terminal settings (`passkey_sites`), and sends them only to kisui-terminal on your computer. Nothing is sent over the network. It needs kisui-terminal: https://github.com/mm1995tk/kisui-terminal

詳しい説明（日本語）：

> kisui-terminal は、内蔵ブラウザを持つ、ターミナルを中心にした作業場です。内蔵ブラウザは OS の WebView なので、iCloud キーチェーンや 1Password のパスキーも、1Password などのブラウザの拡張機能も使えません。そこでページがパスキーを求めると、kisui-terminal は同じページをこのブラウザで開きます。パスワードで（1Password の拡張機能などで）ログインしたいときは、kisui-terminal から手でサイトをこのブラウザに移すこともできます。
>
> この拡張機能は、その続きを受け持ちます。このブラウザでパスキーでログインすると、そのサイトの Cookie を同じコンピューターの kisui-terminal に（native messaging で）送ってタブを閉じ、kisui-terminal はタブをログインした状態で開き直します。パスワードでログインしたときや、パスキーの後にまだ手順が続くサイトでは、済んだら拡張機能のボタンを押してください。
>
> Cookie を読むのは、kisui-terminal の設定（`passkey_sites`）に書いたサイトのものだけで、送る先はあなたのコンピューターの kisui-terminal だけです。ネットワークには何も送りません。kisui-terminal が要ります：https://github.com/mm1995tk/kisui-terminal

カテゴリ：Chrome は「仕事効率化」の「デベロッパー ツール」、Firefox は「Privacy & Security」か「Other」。
スクリーンショット（Chrome は 1280×800 か 640×400 を 1 枚以上）は、実際のブラウザで撮る。
アイコンは `extension/icons/128.png`（kisui-terminal のアイコン）。

### プライバシー（Chrome の「プライバシーへの取り組み」）

- 単一用途（single purpose）：外のブラウザで（パスキーかパスワードで）ログインしたあと、そのサイトのログイン（Cookie）を、同じコンピューターの kisui-terminal の内蔵ブラウザに戻す。
- 権限の理由（English。ダッシュボードの欄に入れる）：
  - `cookies`: Reads the cookies of the sites the user lists in kisui-terminal, after the user logs in there (with a passkey or a password), to hand the login to kisui-terminal.
  - `nativeMessaging`: Talks to kisui-terminal on the same computer: asks it for the list of allowed sites and sends it the cookies of the site the user logged in to.
  - `scripting`: Adds a small script to the pages of the allowed sites only, to notice that a passkey login succeeded (it does not read the credential).
  - `storage`: Remembers, until the browser closes, which tab kisui-terminal opened and the list of allowed sites.
  - Host permission (`https://*/*`, `http://*/*`): The user chooses the sites in kisui-terminal's settings, so the extension cannot know them in advance. It reads cookies only of the sites in that list. `http://*/*` is there because Chrome hands an extension the cookies without the Secure attribute (such as Google's `SID`) only with the `http://` host permission, even for an https site; without it the login does not carry over.
- リモートのコード：使わない（拡張機能の中のスクリプトだけ）。
- 扱うデータ：「認証情報」（Cookie）。使うのは単一用途のためだけで、同じコンピューターの kisui-terminal にだけ渡し、拡張機能の作者やほかの誰にも送らない・売らない・
  単一用途と関係のない目的に使わない。
- プライバシーポリシーの URL：`https://github.com/mm1995tk/kisui-terminal/blob/main/docs/browser-extension-privacy.md`

Firefox の `data_collection_permissions` は `required: ["authenticationInfo"]`：Cookie（認証情報）を拡張機能の外（同じ端末の
kisui-terminal）に渡すので、多めに見て宣言する。Firefox は入れるときに、認証情報を扱うことを利用者に見せて同意をもらう。
送る先は同じ端末だけなので、AMO の審査で `none` でよいと言われたら、そちらに直してよい。
