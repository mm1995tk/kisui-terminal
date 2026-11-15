# Privacy policy of the kisui-terminal browser extension

(日本語は下にあります。)

The kisui-terminal extension for Chrome and Firefox ("the extension") hands a login made with a passkey in your browser back to kisui-terminal, a desktop app on the same computer.

## What it reads

- The cookies of the sites that you list in the settings of kisui-terminal (`passkey_sites`), and only those. It asks kisui-terminal for the list.
- Whether a passkey request (`navigator.credentials.get` / `create`) succeeded on a page of those sites. It does not read the credential, your passkeys, or your passwords.
- The address of a tab, to tell whether it shows one of those sites.

It does not read the cookies, the contents, or the history of any other site.

## Where it sends them

Only to kisui-terminal on the same computer, through the browser's native messaging. kisui-terminal puts the cookies into its built-in browser. The extension sends nothing over the network, has no server, and contains no analytics or tracking. The author receives no data.

## What it keeps

Until the browser closes, the extension remembers which tab kisui-terminal opened and the list of allowed sites (in `storage.session`). It keeps no cookies.

## Sharing

The data is not sold, not shared with anyone, and not used for any purpose other than the one above.

## Contact

https://github.com/mm1995tk/kisui-terminal/issues

---

# kisui-terminal の拡張機能のプライバシーポリシー

Chrome と Firefox の kisui-terminal の拡張機能（以下「拡張機能」）は、ブラウザでパスキーでしたログインを、同じコンピューターのデスクトップアプリ kisui-terminal に戻します。

## 読むもの

- kisui-terminal の設定（`passkey_sites`）に書いたサイトの Cookie だけ。一覧は kisui-terminal に聞きます。
- そのサイトのページで、パスキーの要求（`navigator.credentials.get` / `create`）が成功したかどうか。資格情報・パスキー・パスワードは読みません。
- タブがそのサイトを開いているかを見るための、タブのアドレス。

ほかのサイトの Cookie・中身・履歴は読みません。

## 送る先

同じコンピューターの kisui-terminal だけです（ブラウザの native messaging で）。kisui-terminal は Cookie を内蔵ブラウザに入れます。拡張機能はネットワークに何も送らず、サーバーを持たず、解析や追跡の仕組みもありません。作者は何のデータも受け取りません。

## 残すもの

ブラウザを閉じるまで、kisui-terminal が開いたタブと許可サイトの一覧を覚えます（`storage.session`）。Cookie は残しません。

## 共有

データを売らず、誰とも共有せず、上の目的のほかには使いません。

## 問い合わせ

https://github.com/mm1995tk/kisui-terminal/issues
