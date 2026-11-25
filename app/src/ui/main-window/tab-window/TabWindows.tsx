// 今出しているタブの種類ごとの窓（リーダーの `a`。#457）を出し分ける。
// リーダーの `a` は 1 つで、開く窓だけがタブの種類で変わる。種類を決めるのは features/commands/tabWindow.ts の shownTabKind、
// 開く・閉じるの状態を持つのは page.tsx で、ここは「どの種類に窓があるか」と「その種類の窓」だけを持つ。
// 種類の窓を足すときは、TAB_WINDOW_KINDS に種類を足し、下の出し分けに窓を 1 つ足す（リーダーの定義とコマンドは変えない）。
import { createEffect, Match, Switch, type JSX } from "solid-js";

import type { TabKind } from "../../../features/commands/tabWindow.ts";
import type { Terminals } from "../../../features/terminal/controller.ts";
import { TerminalWindow } from "./TerminalWindow.tsx";

/** 窓がある種類。ここに無い種類のタブでリーダーの `a` を押すと、窓を開かずに、その旨を伝える（features/commands/run.ts）。 */
export const TAB_WINDOW_KINDS: ReadonlySet<TabKind> = new Set<TabKind>([
  "terminal",
]);

/** タブの種類ごとの窓を出す。出していなければ（open が undefined）何も描かない。 */
export function TabWindows(props: {
  /** 出している窓の種類（リーダーの `a` を押したときに出していたタブの種類）。出していなければ undefined */
  open: TabKind | undefined;
  /** 今出しているタブの種類（窓を出している間に変わったら、窓を閉じる） */
  shown: TabKind | undefined;
  /** 窓を閉じる。refocus なら、閉じたあと、今のタブの今の場所（ペイン）にキーを向け直す */
  onClose: (refocus: boolean) => void;
  terminals: Terminals;
  /** 今のターミナルのタブのマシンの色 */
  accent?: string;
  /** リサイズモードに入る */
  onResizeMode: () => void;
}): JSX.Element {
  // 窓の相手のタブが無くなった・別の種類のタブに替わった（タブが閉じた、など）ら、窓を閉じる。別の種類のタブに、開いていた窓の操作をしない
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
    </Switch>
  );
}
