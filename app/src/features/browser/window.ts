// ブラウザのタブの Dialog（リーダーの `a`。#459）に並べる、ページへの操作の行。Window の画面は ui/main-window/tab-window/BrowserWindow.tsx。
// Dialog は、ブラウザのタブ 1 つ（とそのページ）を対象にし、今の状態（題・URL・読み込み・シークレット・履歴の有無）を見せて、
// そのページへの操作を 1 行ずつ並べる。今できない操作は、行にその理由を出す（押してから知るのでなく、先に見せる）。
// 操作そのものは features/commands/run.ts の runBrowserOn が行う（リーダーの Shortcut・設定の Shortcut の browser.* と同じ処理）。
// 画面にも Solid にも依存しない（node --test で確かめられる）。

import { T, type Key } from "../../i18n/index.ts";
import { isNewTab } from "./newTab.ts";
import type { BrowserTab } from "./tabs.ts";

/** ブラウザのタブのページへの操作（コマンドの browser.<op> と同じ名前）。 */
export type BrowserOp =
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "url"
  | "copyUrl"
  | "external"
  | "login"
  | "find"
  | "bookmark"
  | "bookmarks"
  | "devtools";

/** ページが開いていなければ（新しいタブのページ。#238）できない操作。 */
export const NEEDS_PAGE: ReadonlySet<BrowserOp> = new Set<BrowserOp>([
  "back",
  "forward",
  "reload",
  "copyUrl",
  "external",
  "login",
  "find",
  "bookmark",
  "devtools",
]);

/** Dialog の 1 行。 */
export interface BrowserWindowRow {
  op: BrowserOp;
  /** 押す字（Dialog の中のキー。ui/main-window/tab-window/browserWindowKey.ts と同じ） */
  key: string;
  label: string;
  /** 今できないなら、その理由。できるなら undefined */
  why?: string;
}

/**
 * Dialog に並べる順と、押す字。字は、#459 までのリーダーの `o` のグループの字を引き継ぐ。
 * Dialog の中のキーの判定（ui/main-window/tab-window/browserWindowKey.ts）も、この字から作る（字を書くのはここだけ）。
 */
export const BROWSER_WINDOW_ORDER: readonly {
  op: BrowserOp;
  key: string;
  label: Key;
}[] = [
  { op: "back", key: "h", label: "leader.browser.back" },
  { op: "forward", key: "l", label: "leader.browser.forward" },
  { op: "reload", key: "r", label: "leader.browser.reload" },
  { op: "stop", key: "c", label: "leader.browser.stop" },
  { op: "url", key: "u", label: "leader.browser.url" },
  { op: "copyUrl", key: "y", label: "leader.browser.copyUrl" },
  { op: "external", key: "e", label: "leader.browser.external" },
  { op: "login", key: "s", label: "leader.browser.login" },
  { op: "find", key: "/", label: "leader.browser.find" },
  { op: "bookmark", key: "b", label: "leader.browser.bookmark" },
  { op: "bookmarks", key: "B", label: "leader.browser.bookmarks" },
  { op: "devtools", key: "i", label: "leader.browser.devtools" },
];

/** 操作 op が、タブ t で今できないなら、その理由。 */
export function whyNot(t: BrowserTab, op: BrowserOp): string | undefined {
  if (NEEDS_PAGE.has(op) && isNewTab(t)) return T("browserWindow.why.noPage");
  switch (op) {
    case "back":
      return t.history?.back ? undefined : T("browserWindow.why.noBack");
    case "forward":
      return t.history?.forward ? undefined : T("browserWindow.why.noForward");
    case "stop":
      return t.loading ? undefined : T("browserWindow.why.notLoading");
    case "login":
      return t.incognito ? T("cannot.browser.login.incognito") : undefined;
    default:
      return undefined;
  }
}

/** タブ t の Dialog に並べる行（上から順）。 */
export function browserWindowRows(t: BrowserTab): BrowserWindowRow[] {
  return BROWSER_WINDOW_ORDER.map(({ op, key, label }) => {
    const why = whyNot(t, op);
    return { op, key, label: T(label), ...(why ? { why } : {}) };
  });
}

/** 選んでいる行。want が並びに無ければ（初め）、上から見て最初の今できる行（どれもできなければ先頭）。 */
export function selectedRow(
  rows: readonly BrowserWindowRow[],
  want: BrowserOp | undefined,
): BrowserOp | undefined {
  if (want !== undefined && rows.some((r) => r.op === want)) return want;
  return (rows.find((r) => !r.why) ?? rows[0])?.op;
}

/** 選んでいる行から、step の向きに、次の今できる行。無ければ（端）今のまま。 */
export function stepRow(
  rows: readonly BrowserWindowRow[],
  current: BrowserOp | undefined,
  step: 1 | -1,
): BrowserOp | undefined {
  const at = rows.findIndex((r) => r.op === current);
  for (let i = at + step; i >= 0 && i < rows.length; i += step)
    if (!rows[i].why) return rows[i].op;
  return current;
}

/** Dialog の上に出す、タブの状態の印。 */
export interface BrowserWindowMark {
  text: string;
  /** 知らせの色で出す（読み込めなかった） */
  alert?: boolean;
}

/** タブ t の状態の印（シークレット・読み込み中・読み込めなかった・通信を記録中・表示の大きさ）。 */
export function browserWindowMarks(t: BrowserTab): BrowserWindowMark[] {
  const out: BrowserWindowMark[] = [];
  if (t.incognito) out.push({ text: T("browserWindow.incognito") });
  if (t.loading)
    out.push({
      text: T("browserWindow.loading", {
        percent: Math.round(t.loading.progress),
      }),
    });
  if (t.loadError)
    out.push({ text: T("browserWindow.loadFailed"), alert: true });
  if (t.proxy) out.push({ text: T("browserWindow.proxy") });
  if (t.zoom !== undefined && t.zoom !== 1)
    out.push({
      text: T("browserWindow.zoom", { percent: Math.round(t.zoom * 100) }),
    });
  return out;
}

/** Dialog の見出し：ページの題。無ければ URL。新しいタブのページなら「新しいタブ」。 */
export function browserWindowTitle(t: BrowserTab): string {
  if (isNewTab(t)) return T("browserWindow.newTabTitle");
  return t.title || t.url;
}
