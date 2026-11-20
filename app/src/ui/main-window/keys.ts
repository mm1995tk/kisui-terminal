// メインウィンドウが受けるキー（入力）。リーダー（Cmd+K / Ctrl+Shift+K）と近道、リサイズモードのキー、ファイルツリーから端末へ戻るキー。
// 何を受けるかは、コマンドの表（features/commands/commands.ts）が決める。受けたコマンドを動かすのは runCommand（features/commands/run.ts）。
// リーダーに入っている間は、次に押せるキーの一覧を出す（commands/LeaderMenu.tsx）。
import { onCleanup, onMount, untrack, type Accessor } from "solid-js";

import type { BrowserOs } from "../../features/browser/os.ts";
import {
  afterKeyUp,
  IDLE,
  route,
  type Command,
  type RouterState,
} from "../../features/commands/commands.ts";
import {
  closeTarget,
  IS_MAC,
  type KeyLike,
} from "../../features/commands/guiKeys.ts";
import type { ShellApi } from "../../features/sessions/shell.ts";
import type { TermGroup } from "../../features/terminal/group.ts";
import { setLeaderPath } from "./commands/LeaderMenu.tsx";
import type { WindowEls } from "./els.ts";
import type { FocusUi } from "./focus.ts";
import { resizeAction, resizeKeyName } from "./panes.ts";
import { isLeaveExplorerKey } from "./sidebar/file-tree/explorerFocus.ts";

/** createGuiKeys が返すもの。 */
export type GuiKeys = ReturnType<typeof createGuiKeys>;

/** メインウィンドウのキーの受け取りを始める。window の keydown を capture で受け、コマンドの表に当たるキーを runCommand に渡す。出すのをやめたら受け取りもやめる。 */
export function createGuiKeys(deps: {
  els: WindowEls;
  shell: Pick<ShellApi, "onCloseRequest" | "windowClose">;
  /** ページにキーがあるときに押されたキーの知らせ（内蔵ブラウザを使わないなら undefined） */
  onTabKey: BrowserOs["onTabKey"] | undefined;
  resizeMode: Accessor<boolean>;
  /** リサイズモードで key（TUI と同じ名前。panes.ts）を押した */
  resizeKey: (key: string) => void;
  /** 今のワークスペースで出しているブラウザのタブ（ターミナルのタブを出していれば undefined） */
  shownBrowserTab: Accessor<unknown>;
  /** フォーカスしているワークスペースのターミナル */
  termGroup: () => TermGroup | undefined;
  runCommand: (c: Command) => void;
  /** リーダーを閉じた（続けてワークスペースを移る間は出さずにいたファイルツリーを出す） */
  endWalk: () => void;
  focusUi: Pick<
    FocusUi,
    "focusTerminal" | "hasPageReturn" | "markPageReturn" | "returnToPageLater"
  >;
}) {
  const { els, resizeMode, resizeKey, shownBrowserTab, termGroup, runCommand } =
    deps;
  const api = deps.shell;
  const { focusTerminal, returnToPageLater } = deps.focusUi;
  // リーダー（Cmd+K / Ctrl+Shift+K）の状態。入っている間は、次に押せるキーの一覧を出す（LeaderMenu）
  let router: RouterState = IDLE;
  const setRouter = (next: RouterState) => {
    if (next.leader !== router.leader) setLeaderPath(next.leader, next.escaped);
    // リーダーを閉じたら、続けて移る間は出さずにいたファイルツリーを、行き先のワークスペースの分だけ出す
    if (!next.leader) deps.endWalk();
    const left = router.leader !== null && next.leader === null;
    router = next;
    // ページから入ったリーダーを出たら、ページにキーを戻す（内蔵ブラウザ）
    if (left && deps.focusUi.hasPageReturn()) returnToPageLater();
  };
  // GUI が受けるキーなので、欄やターミナルに届く前（capture）に取って、shj にもシェルにも送らない。
  // 何を受けるかは、コマンドの表（commands.ts）が決める。リーダーに入っていないときは、その表のキーに当たるものだけを受け、
  // ほかのキーは今までどおりターミナル（shj やシェル）に届く
  const onGuiKey = (e: KeyboardEvent) => {
    // 隣へ移るのは、ターミナルを並べていて、キーがターミナルに向いているときだけ
    const card = els.main?.querySelector(":scope > .terminal");
    const routed = route(router, e, {
      mac: IS_MAC,
      dialogOpen: !!document.querySelector("dialog[open]"),
      resizeMode: resizeMode(),
      // Cmd+W（Mac）は、キーがターミナルの欄（画像・動画・PDF の欄を含む）に向いているときか、どこにも向いていないときに、
      // 今の欄だけを閉じる。どちらでも、アプリの窓は閉じない（#83）
      inPane:
        !shownBrowserTab() &&
        closeTarget(e.target, card, !!termGroup()) === "pane",
      // 内蔵ブラウザのタブを出している間は、Cmd+R / Ctrl+Shift+R を読み込み直しにする
      browser: !!shownBrowserTab(),
    });
    setRouter(routed.state);
    if (routed.consume) {
      e.preventDefault();
      e.stopPropagation();
      if (routed.run && (!e.repeat || routed.repeat)) runCommand(routed.run);
      return;
    }
    // リサイズモード（#526）：キーは境界を動かすのに使い、ターミナルには送らない。入るのは Cmd+R / Ctrl+Shift+R（Alt+R は端末に渡す）
    const rname = resizeKeyName(e, IS_MAC);
    if (rname && resizeMode()) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat || resizeAction(rname).kind !== "exit") resizeKey(rname);
      return;
    }
    // ファイルツリーから端末へ戻る（Esc・Ctrl+E）。メニューや窓の中の Esc には触らない
    if (
      isLeaveExplorerKey(e) &&
      e.target instanceof Element &&
      els.nav?.contains(e.target) &&
      e.target.closest(".tree-row")
    ) {
      e.preventDefault();
      e.stopPropagation();
      focusTerminal();
    }
  };
  const onGuiKeyUp = () => setRouter(afterKeyUp(router));
  // 窓を離れたり、画面を押したりしたら、リーダーを出る（キーが向く先が変わるため）
  const leaveLeader = () => {
    if (router.leader) setRouter(IDLE);
  };
  window.addEventListener("keydown", onGuiKey, true);
  window.addEventListener("keyup", onGuiKeyUp, true);
  window.addEventListener("blur", leaveLeader);
  window.addEventListener("pointerdown", leaveLeader, true);
  // await の後は Owner が無いので、onCleanup は先に登録する
  const offs: (() => void)[] = [];
  onCleanup(() => {
    window.removeEventListener("keydown", onGuiKey, true);
    window.removeEventListener("keyup", onGuiKeyUp, true);
    window.removeEventListener("blur", leaveLeader);
    window.removeEventListener("pointerdown", leaveLeader, true);
    offs.forEach((f) => f());
  });

  /** ページにキーがあったときに押されたキー（リーダー・近道と、リーダーに入ったあと画面に移るまでのキー）。 */
  function onPageKey(e: KeyLike) {
    deps.focusUi.markPageReturn();
    const routed = route(router, e, {
      mac: IS_MAC,
      dialogOpen: !!document.querySelector("dialog[open]"),
      resizeMode: resizeMode(),
      // ページを出している間は、ペインに向いていないものとする（Cmd+W で、見えないペインを閉じない）
      inPane: false,
      browser: !!shownBrowserTab(),
    });
    setRouter(routed.state);
    if (routed.consume && routed.run && (!e.repeat || routed.repeat))
      runCommand(routed.run);
    returnToPageLater();
  }

  onMount(async () => {
    // Mac のメニューの「閉じる」（Cmd+W）。PDF の欄の中を押した後は、キーが画面に届かないので、ここで受ける（#111）。
    // キーが画面に届くときは、onGuiKey が先に受けて止めるので、ここには来ない
    if (api.onCloseRequest) {
      offs.push(
        await api.onCloseRequest(() => {
          // 内蔵ブラウザのタブを出している間は、見えないペインも窓も閉じない
          if (untrack(shownBrowserTab)) return;
          const card = els.main?.querySelector(":scope > .terminal");
          if (
            closeTarget(document.activeElement, card, !!termGroup()) === "pane"
          ) {
            runCommand({ id: "pane.close" });
          } else {
            void api.windowClose?.();
          }
        }),
      );
    }
    if (deps.onTabKey) offs.push(await deps.onTabKey(onPageKey));
  });

  return {
    /** リーダーに入っているか */
    inLeader: () => !!router.leader,
  };
}
