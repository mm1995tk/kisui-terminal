// 今出しているタブの種類ごとの窓（リーダーの `a`。#457）を出し分ける。
// リーダーの `a` は 1 つで、開く窓だけがタブの種類で変わる。種類を決めるのは features/commands/tabWindow.ts の shownTabKind、
// 開く・閉じるの状態を持つのは page.tsx で、ここは種類ごとの窓の出し分けだけを持つ。
// ターミナルのタブの窓（#457）・DB のタブの窓（#458）・ブラウザのタブの窓（#459）で、タブの種類（TabKind）の全部に窓がある。
// 種類を足すときは、下の出し分けに窓を 1 つ足す（リーダーの定義とコマンドは変えない）。
import { createEffect, Match, Switch, type JSX } from "solid-js";

import type { TabKind } from "../../../features/commands/tabWindow.ts";
import type { Terminals } from "../../../features/terminal/controller.ts";
import { TerminalWindow } from "./TerminalWindow.tsx";
import { DbWindow } from "./DbWindow.tsx";
import { BrowserWindow } from "./BrowserWindow.tsx";

/** タブの種類ごとの窓を出す。出していなければ（open が undefined）何も描かない。 */
export function TabWindows(props: {
  /** 出している窓の種類（リーダーの `a` を押したときに出していたタブの種類）。出していなければ undefined */
  open: TabKind | undefined;
  /** 今出しているタブの種類（窓を出している間に変わったら、窓を閉じる） */
  shown: TabKind | undefined;
  /** 窓を閉じる。refocus なら、閉じたあと、今のタブの今の場所（ペイン・SQL の入力欄）にキーを向け直す */
  onClose: (refocus: boolean) => void;
  terminals: Terminals;
  /** 今のターミナルのタブのマシンの色 */
  accent?: string;
  /** リサイズモードに入る */
  onResizeMode: () => void;
  /** DB のタブ（DB のタブの窓が使う持ち物） */
  db: Parameters<typeof DbWindow>[0]["db"];
  /** マシンの名前 */
  labelOf: (target: string) => string;
  /** マシンにつながっているか */
  connected: (target: string) => boolean;
  /** macOS か */
  mac: boolean;
  /** サイドバーの DB のタブの木にキーを向ける */
  onFocusDbTree: () => void;
  /** 今出しているブラウザのタブ（ブラウザのタブの窓の相手） */
  shownBrowserTab: Parameters<typeof BrowserWindow>[0]["shown"];
  /** ブラウザのタブのページに操作を行う（features/commands/run.ts の runBrowserOn） */
  runBrowser: Parameters<typeof BrowserWindow>[0]["run"];
}): JSX.Element {
  // 窓の相手のタブが無くなった・別の種類のタブに替わった（タブが閉じた、など）ら、窓を閉じる。別の種類のタブに、開いていた窓の操作をしない
  // （同じ種類で別のタブに替わったときは、DB・ブラウザのタブの窓が自分で閉じる）
  createEffect(() => {
    if (props.open !== undefined && props.shown !== props.open)
      props.onClose(true);
  });
  return (
    <Switch>
      <Match when={props.open === "terminal"}>
        <TerminalWindow
          terminals={props.terminals}
          accent={props.accent}
          onFocusPane={(id) => {
            // 先に窓を閉じる（閉じると、開く前にフォーカスがあった所へ戻る）。そのあとで、選んだペインにキーを向ける
            props.onClose(false);
            props.terminals.focusPane(id);
          }}
          onResize={() => {
            props.onClose(true);
            props.onResizeMode();
          }}
          onCancel={(acted) => props.onClose(acted)}
        />
      </Match>
      <Match when={props.open === "db"}>
        <DbWindow
          db={props.db}
          labelOf={props.labelOf}
          connected={props.connected}
          mac={props.mac}
          onFocusTree={props.onFocusDbTree}
          onClose={props.onClose}
        />
      </Match>
      <Match when={props.open === "browser"}>
        <BrowserWindow
          shown={props.shownBrowserTab}
          run={props.runBrowser}
          onClose={props.onClose}
        />
      </Match>
    </Switch>
  );
}
