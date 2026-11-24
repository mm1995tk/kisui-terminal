# 外のブラウザの拡張機能（パスキーのログインを kisui-terminal に戻す）

内蔵ブラウザでパスキーが要るとき、kisui-terminal は同じ URL を Firefox で開く（`docs/passkey-extension.md`）。
この拡張機能は、Firefox でログインが済んだら（パスキーが通った、またはタブがログインを終えて着いたらしいページに移った）、そのサイトの Cookie を native messaging で kisui-terminal に送り、タブを閉じる。
コードは `extension/`。Firefox の拡張機能（Manifest V3。background は `background.scripts`）として書いてある。

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
   パスキーの管理の拡張機能（1Password など）も同じ関数を自分のものに置き換え、パスキーを自分で出すときはもとの関数を呼ばない。
   そのため `page.js` は、拡張機能が入る順によらず、ページが呼ぶ関数がいつも `page.js` の包みになるようにする：`navigator.credentials` を
   読むたびに、返す入れ物の `get` / `create` を `page.js` の accessor にし直し、その accessor は読まれたときの関数（ほかの拡張機能が
   代入・`Object.defineProperty` したもの、prototype のもの）を包んで返す（#433）。
4. URL が変わったら送る（#438）：Firefox でログイン済みのときや、パスワードでログインしたときは、パスキーが通らない。そこで、そのタブの URL が、
   kisui-terminal が開いた URL（`waiting` の `url`。タブの最初のページはリダイレクトの後のことがあるので、こちらと比べる）から、
   ログインを終えて着いたらしいページに変わったら、5 と同じに落ち着くのを待って送る。着いたらしいページは、待っている項目に当たり、
   ログインの途中らしくない URL（`lib.js` の `loginLike`：path の区切りに `login`・`session`・`signin`・`twofactor`・`2fa`・`mfa`・`otp`・
   `challenge`・`verif`・`auth` などを含むもの、host の最初のラベルが `accounts`・`login`・`signin`・`auth`・`sso` のもの。広めに取る）。
   開いた URL のままでも、そのあとログインの途中らしいページを通っていれば（`o s` で開いたページがログインのページへリダイレクトし、
   済むと元のページに戻るサイト）、着いたと見る。落ち着くのを待つ間に別のページに移ったら、移った先から待ち直し、ログインの途中らしいページ・
   サイトの外・開いた URL に移ったら待つのをやめる。送る直前にも今の URL を見直す。URL は `tabs.onUpdated` で知る（host の権限 `https://*/*` で
   URL が見えるので、`tabs` の権限は要らない）。パスキーが通れば、URL で待っていたときもパスキーの待ち方に替える。
   URL を使うのは kisui-terminal が開いたタブ（覚えたタブ）のものだけで、覚えるのは開いた URL（kisui-terminal の答えのもの）と、ログインの途中らしいページを通ったかだけ。
5. 落ち着くのを待つ：パスキーが通ってから（4 では着いたらしいページに移ってから）2 秒は待ち、そのあと、タブの読み込みが済み、そのサイトに送られる Cookie が 1.5 秒変わらなければ
   落ち着いたと見る。15 秒を過ぎたら、落ち着かなくても送る。そのときタブが別のサイトに移っていれば送らない（手で戻るボタンを使う）。
   サイトは待っている項目で比べるので、`.google.com` で待っていれば、`accounts.google.com` から `myaccount.google.com` に移っていても送る。
6. 今のタブのページに送られる Cookie だけを読み（`cookies.getAll` を、タブの host の URL と、その host のドメインで。タブの Cookie の置き場から）、
   取り決めの `cookies` で、その項目を `waiting` に挙げた受け口に送る。`done` が返ったらタブを閉じる。断られたら、拡張機能のボタンに
   `!` を付け、ボタンの説明（マウスを乗せると出る）に理由を書く。
7. 手で戻るボタン（拡張機能のボタン）：パスキーの後にまだ手順が続くサイトと、URL が変わらない・ログインの途中らしい URL に着くサイトのため。押すと、今のタブの host が許可サイトの項目に当たり、kisui-terminal が
   その項目を待っていれば、今のタブのページに送られる Cookie を送り、タブを閉じる（`.google.com` で待っていれば、`myaccount.google.com` のタブからも送れる）。キーは、Firefox の
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

`http://*/*` は持たない。https のサイトの Cookie のうち Secure の付かないもの（Google の `SID` など）も、Firefox では
`https://*/*` だけで読める（Firefox のソースの `toolkit/components/extensions/parent/ext-cookies.js` の `query()` と
`MatchPattern.cpp` の `MatchPatternCore::MatchesCookie`。Issue #286）。0.1.1 から 0.2.1 までは持っていたが、0.2.2 で外した。
外したのは新しく入れる人にだけ効く。Firefox はもらった host の権限を拡張機能の id ごとに覚えていて、更新で manifest から
消えても取り消さない（消えるのは拡張機能を削除したとき）ので、0.2.1 以前から更新した人には `http://*/*` が残る。
0.2.2 を確かめるときは、前の版を入れたことの無いプロファイルで入れるか、前の版を削除してから入れ、
背景のコンソールで `await browser.permissions.getAll()` の `origins` に `http://*/*` が無いことを見てから試す。

Firefox は、入れるときに host の権限を断れる。断ったときは、拡張機能のボタンを押すと頼み直す。
版を上げて host の権限が増えたときも、更新で新しい権限をもらえていなければ、パスキーの後に自動で送る道は
権限を確かめないので、足りない Cookie を欠いたまま送る。そのときも、拡張機能のボタンを 1 回押すと頼み直す。

## 作る・試す

```sh
npm run test:extension     # テスト（nix flake check の checks.extension も同じもの）
npm run typecheck:extension # JSDoc の型の検査（tsc -p extension。npm test にも入っている。web-test の check が回す）
npm run build:extension    # extension/dist/ に firefox/ と、addons.mozilla.org に上げる zip を作る
nix build .#kisui-terminal-extension   # 同じものを Nix で作る（result/ に出る）
```

zip の中身は `extension/` のファイルそのもの（`manifest.json` も。まとめも縮めもしない）。同じソースからは同じバイト列になる（中のファイルの順と時刻を固定している）。

手で入れて試す：`about:debugging#/runtime/this-firefox` の「一時的なアドオンを読み込む」で `extension/dist/firefox/manifest.json` を選ぶ
  （Firefox を閉じると外れる。署名の無い拡張機能を残しておけるのは Developer Edition・Nightly・ESR だけ）。
  id（`kisui-terminal@mm1995tk.github.io`）が決まっているので、kisui-terminal の受け口にそのままつながる。

## ストアに出す（オーナーの作業）

ストアのアカウントの登録・提出・公開は、オーナーのアカウントで行う。このリポジトリが用意するのは、上げる zip と、下の説明文・権限の理由・
プライバシーの説明まで。

公開しているのは addons.mozilla.org（https://addons.mozilla.org/addon/kisui-terminal-passkey-login/ ）。

### addons.mozilla.org（AMO）

1. https://addons.mozilla.org/developers/ に Firefox アカウントでログインし、開発者の同意をする（登録料は無い）。
2. 「新しいアドオンを提出」で「このサイトで公開する」を選び、`extension/dist/kisui-terminal-firefox-<版>.zip` を上げる。
   id は manifest の `kisui-terminal@mm1995tk.github.io` に決まっている（AMO は id を付けない）。
3. ソースコードの提出を聞かれたら「いいえ」：zip の中は `extension/` のファイルそのもの（まとめも縮めもしていない）。
4. 下の「ストアの説明」と「プライバシー」を入れ、審査に出す。

済み：版 0.1.0 が自動の審査を通り、公開された（2026-11-18）。

### 版を上げるとき

`extension/manifest.json` の `version` を上げて zip を作り直し、addons.mozilla.org に上げる。kisui-terminal の版とは別に数える。
0.2.0 で、`passkey_sites` の `.google.com` の書き方（取り決めの版 2）を読めるようにした（#279）。
0.2.1 で、Chrome のためのコード（`importScripts`・`chrome` の API・`pendingUrl`・Chrome の manifest の作り分け）を外した（#433。Firefox での動きは変えていない）。
0.2.2 で、host の権限から `http://*/*` を外した（#286）。
0.2.3 で、`cookies` にタブの今の URL（`url`）を入れて送るようにした（#276。kisui-terminal は、内蔵ブラウザのタブでその URL を開き直す）。
0.2.4 で、パスキーの管理の拡張機能（1Password など）が `navigator.credentials` を置き換えていても、パスキーが通ったことを知れるようにした（#433）。
0.2.5 で、kisui-terminal が開いたタブの URL が、開いた URL からログインを終えて着いたらしいページに変わったら、パスキーが通らなくても送るようにした（#438。Firefox でログイン済みのとき・パスワードでログインしたとき）。
取り決め（`docs/passkey-extension.md`）を変えるときは、kisui-terminal と拡張機能を合わせて変える。

### ストアの説明

名前と短い説明は `extension/_locales/{en,ja}/messages.json` の `extensionName` と `extensionDescription`（ストアは manifest から読む）。

下の詳しい説明とプライバシーの欄は、パスワードでのログイン（#276。kisui-terminal のリーダーの `o s`）も含めた案に直してある。審査に出したあとに直したので、ストアへの反映は公開の後にオーナーが行う（拡張機能そのものは変えていないので、版は上げない）。

詳しい説明（English）：

> kisui-terminal is a terminal-centered workspace with a built-in browser. The built-in browser is the WebView of the OS, so it cannot use the passkeys of iCloud Keychain or 1Password, nor browser extensions such as 1Password. When a page there asks for a passkey, kisui-terminal opens the same page in this browser instead. You can also move a site to this browser yourself from kisui-terminal, to log in with a password (for example with the 1Password extension).
>
> This extension finishes the round trip: after you log in with your passkey here, it sends the cookies of that site to kisui-terminal on the same computer (through native messaging), closes the tab, and kisui-terminal reloads its tab, logged in. When you log in with a password, or are already logged in here, it does the same once the tab moves on to a page of the site that is not a step of the login. If the tab does not come back by itself (for example the site asks for more steps after the passkey), press the extension's button when you are done.
>
> It reads cookies only of the sites you list in the kisui-terminal settings (`passkey_sites`), and sends them only to kisui-terminal on your computer. Nothing is sent over the network. It needs kisui-terminal: https://github.com/mm1995tk/kisui-terminal

詳しい説明（日本語）：

> kisui-terminal は、内蔵ブラウザを持つ、ターミナルを中心にした作業場です。内蔵ブラウザは OS の WebView なので、iCloud キーチェーンや 1Password のパスキーも、1Password などのブラウザの拡張機能も使えません。そこでページがパスキーを求めると、kisui-terminal は同じページをこのブラウザで開きます。パスワードで（1Password の拡張機能などで）ログインしたいときは、kisui-terminal から手でサイトをこのブラウザに移すこともできます。
>
> この拡張機能は、その続きを受け持ちます。このブラウザでパスキーでログインすると、そのサイトの Cookie を同じコンピューターの kisui-terminal に（native messaging で）送ってタブを閉じ、kisui-terminal はタブをログインした状態で開き直します。パスワードでログインしたときや、このブラウザでログイン済みのときも、タブがそのサイトのログインの途中でないページに移れば同じようにします。自動で戻らないとき（パスキーの後にまだ手順が続くサイトなど）は、済んだら拡張機能のボタンを押してください。
>
> Cookie を読むのは、kisui-terminal の設定（`passkey_sites`）に書いたサイトのものだけで、送る先はあなたのコンピューターの kisui-terminal だけです。ネットワークには何も送りません。kisui-terminal が要ります：https://github.com/mm1995tk/kisui-terminal

カテゴリ：「Privacy & Security」か「Other」。
スクリーンショットは、実際のブラウザで撮る。
アイコンは `extension/icons/128.png`（kisui-terminal のアイコン）。

### プライバシー

- 用途：外のブラウザで（パスキーかパスワードで）ログインしたあと、そのサイトのログイン（Cookie）を、同じコンピューターの kisui-terminal の内蔵ブラウザに戻す。
- 権限の理由（English。審査の担当者への説明に使う）：
  - `cookies`: Reads the cookies of the sites the user lists in kisui-terminal, after the user logs in there (with a passkey or a password), to hand the login to kisui-terminal.
  - `nativeMessaging`: Talks to kisui-terminal on the same computer: asks it for the list of allowed sites and sends it the cookies of the site the user logged in to.
  - `scripting`: Adds a small script to the pages of the allowed sites only, to notice that a passkey login succeeded (it does not read the credential).
  - `storage`: Remembers, until the browser closes, which tab kisui-terminal opened and the list of allowed sites.
  - Host permission (`https://*/*`): The user chooses the sites in kisui-terminal's settings, so the extension cannot know them in advance. It reads cookies only of the sites in that list.
- リモートのコード：使わない（拡張機能の中のスクリプトだけ）。
- 扱うデータ：「認証情報」（Cookie）。使うのは上の用途のためだけで、同じコンピューターの kisui-terminal にだけ渡し、拡張機能の作者やほかの誰にも送らない・売らない・
  用途と関係のない目的に使わない。
- プライバシーポリシーの URL：`https://github.com/mm1995tk/kisui-terminal/blob/main/docs/browser-extension-privacy.md`

Firefox の `data_collection_permissions` は `required: ["authenticationInfo"]`：Cookie（認証情報）を拡張機能の外（同じ端末の
kisui-terminal）に渡すので、多めに見て宣言する。Firefox は入れるときに、認証情報を扱うことを利用者に見せて同意をもらう。
送る先は同じ端末だけなので、AMO の審査で `none` でよいと言われたら、そちらに直してよい。
