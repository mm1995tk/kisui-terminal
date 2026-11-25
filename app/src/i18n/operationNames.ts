// 画面の文のうち、日本語の UI でも英語のままにするもの（操作の名前）のキー。
//
// 操作の名前は、ユーザーとコーディングエージェントが同じ言葉で指せる共通の用語として使うので、
// ja.ts でも en.ts と同じ英語の文にする。操作の名前とは次のもの。
//   ボタン・メニューの項目・リーダーの案内に並ぶ操作の名前・キーの一覧（?）の操作の名前・
//   キーの案内（「select」「cancel」など）・見出し（ダイアログやポップアップの題）
// 説明の文（ヒント・お知らせ・エラー・確認の文・案内の説明）は、日本語にする。
//
// 迷ったら「その言葉でその操作を指すか」で決める。指すなら操作の名前（ここに足す）。
// i18n.test.ts が、ここにあるキーの ja.ts の文が en.ts と同じことを確かめる。
import type { Key } from "./en.ts";

/** キーの名前の決まりで操作の名前になるもの。 */
const OPERATION_NAME_PATTERNS: readonly RegExp[] = [
  // リーダーの案内（`leader.foot.*` の「Esc で抜ける」は案内の説明）
  /^leader\.(?!foot\.)/,
  // `?` のキーの一覧の、場所ごとの見出しと操作の名前（`.lead` はその場所の説明）
  /^place\.(?!.*\.lead$)/,
  // `?` のキーの一覧の列の見出し
  /^keys\.col\./,
  // ボタン・右クリックのメニュー
  /^button\./,
  /^treeMenu\./,
  // 画面の下に出るキーの案内（「select」「cancel」など）
  /^basic\./,
  /\.keys\.[A-Za-z]+$/,
  /^proxy\.hint\./,
];

/** 名前の決まりに当てはまらない、操作の名前（ダイアログの見出し・ボタン・タブなど）。 */
const OPERATION_NAME_KEYS: readonly Key[] = [
  "help.keys",
  "keys.label",
  // ダイアログ・ポップアップの見出し
  "picker.title",
  "switcher.title",
  "tabMove.title",
  "kindPicker.title",
  "deleteDialog.title",
  "closeTab.title",
  "closeWorkspace.title",
  "installCard.title",
  "addMachine.title",
  "clipboardAsk.title",
  "mascot.title",
  "transfer.write.title",
  "transfer.read.title",
  "newTab.title",
  "newTab.incognito",
  "bookmarks.title",
  "dialog.tree.newFile",
  "dialog.tree.newDir",
  "db.picker.title",
  "db.propose.title",
  "db.elevate.title",
  "db.export.title",
  "db.history.title",
  "proxy.title",
  "proxy.edit.title",
  "proxy.edit.heldTitle",
  // ボタン・選ぶ項目
  "kindPicker.terminal",
  "kindPicker.browser",
  "transfer.allow",
  "transfer.deny",
  "installCard.yes",
  "installCard.no",
  "clipboardAsk.allow",
  "deleteDialog.yes",
  "closeWorkspace.yes",
  "addMachine.add",
  "update.later",
  "update.install",
  "askpass.cancel",
  "download.reveal",
  "download.open",
  "browser.loadFailed.retry",
  "history.close",
  "switcher.new",
  "switcher.newTab",
  "sidebar.rename",
  "sidebar.newWorkspace",
  "sidebar.closeWorkspace",
  "sidebar.closeTab",
  "sidebar.addTab",
  "sidebar.addTerminal",
  "sidebar.addTerminalPick",
  "sidebar.addBrowser",
  "sidebar.renameTab",
  "emptyWorkspace.addTerminal",
  "emptyWorkspace.addBrowser",
  "emptyWorkspace.addDb",
  "emptyWorkspace.closeWorkspace",
  "db.view.run",
  "db.view.cancel",
  "db.view.prevPage",
  "db.view.nextPage",
  "db.view.data",
  "db.view.structure",
  "db.tree.reload",
  "db.propose.yes",
  "db.elevate.do",
  "db.export.clipboard",
  "db.export.file",
  "db.password.ok",
  "db.history.close",
  "db.history.use",
  "proxy.hold.start",
  "proxy.hold.stop",
  "proxy.held.forward",
  "proxy.held.edit",
  "proxy.held.drop",
  "proxy.edit.send",
  "proxy.edit.forward",
  "proxy.edit.cancel",
  "history.label",
  "machineDialog.label",
  "askpass.label",
  "db.password.label",
];

const names = new Set<string>(OPERATION_NAME_KEYS);

/** 日本語の UI でも英語のままにする、操作の名前のキーか。 */
export function isOperationNameKey(key: string): boolean {
  return names.has(key) || OPERATION_NAME_PATTERNS.some((p) => p.test(key));
}
