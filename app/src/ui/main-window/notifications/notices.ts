// 右下に積む知らせを組み立てる（文とボタン）。つながらない・別の GUI に移った・できなかったこと・近道の間違い・ダウンロード。
// 描くのは Notices.tsx。
import { T } from "../../../i18n/index.ts";
import { createMemo, createSignal, type Accessor } from "solid-js";

import type { Downloads } from "../../../features/browser/downloads.ts";
import type { DownloadDone } from "../../../features/browser/os.ts";
import { leaderKeyName } from "../../../features/commands/commands.ts";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import type { Problem, ReportProblem } from "../../../features/problem.ts";
import type { Sessions } from "../../../features/sessions/controller.ts";
import type { SessionState } from "../../../features/sessions/session.ts";
import {
  describeClient,
  handoverFailure,
} from "../../../features/sessions/status.ts";
import type { Notice } from "./Notices.tsx";

/** 右下に積む知らせの並びを作る（古い順）。元の状態が同じ間は、同じ知らせのオブジェクトを返す（描き直さないため）。 */
export function createNotices(deps: {
  /** 設定の [gui.shortcuts] の間違い（あればお知らせに出す） */
  shortcutProblems: string[] | undefined;
  /** 設定ファイルの [[gui.machines]] のうち、名前が local のマシン（ssh の行き先。あればお知らせに出す。`--machine` で選べない） */
  localNamed?: string[];
  /** できなかったこと（無ければ null） */
  focusError: Accessor<Problem | null>;
  setFocusError: ReportProblem;
  sessions: Pick<
    Sessions,
    "states" | "targets" | "labelOf" | "connect" | "disconnect"
  >;
  downloads: Pick<Downloads, "downloads" | "dropDownload" | "useDownload">;
}) {
  const { focusError, setFocusError } = deps;
  const { states, targets, labelOf, connect, disconnect } = deps.sessions;
  const { downloads, dropDownload, useDownload } = deps.downloads;
  // 右下の知らせのうち、閉じたもの（状態が変われば、また出す）
  const [dismissed, setDismissed] = createSignal<ReadonlySet<SessionState>>(
    new Set(),
  );

  /** ダウンロード 1 つの知らせ（同じダウンロードには同じオブジェクトを返す）。 */
  const downloadNotices = new WeakMap<DownloadDone, Notice>();
  function downloadNotice(d: DownloadDone): Notice {
    const had = downloadNotices.get(d);
    if (had) return had;
    const close = { label: T("button.close"), run: () => dropDownload(d) };
    const leader = leaderKeyName(IS_MAC);
    const n: Notice = d.ok
      ? {
          title: T("download.done.title"),
          text: T("download.done.text", { name: d.name, dir: d.dir, leader }),
          secondary: [
            close,
            {
              label: T("download.reveal"),
              run: () => useDownload(d, "reveal"),
            },
          ],
          primary: {
            label: T("download.open"),
            run: () => useDownload(d, "open"),
          },
          dismiss: close.run,
        }
      : {
          title: T("download.failed.title"),
          text: d.name,
          primary: close,
          dismiss: close.run,
        };
    downloadNotices.set(d, n);
    return n;
  }

  // 知らせのオブジェクトは、元のもの（SessionState・focusError のオブジェクト）が同じなら使い回す。
  // 作り直すと Notices が描き直し、ほかのマシンの状態が変わるだけで読み上げ直し、ボタンのフォーカスも消えるため
  const noticeOf = new WeakMap<SessionState, Notice | null>();
  const [shortcutDismissed, setShortcutDismissed] = createSignal(false);
  const shortcutNotice: Notice | undefined = deps.shortcutProblems?.length
    ? {
        title: T("notice.shortcuts.title"),
        text: T("notice.shortcuts.text"),
        error: deps.shortcutProblems.join("\n"),
        primary: {
          label: T("button.close"),
          run: () => setShortcutDismissed(true),
        },
        dismiss: () => setShortcutDismissed(true),
      }
    : undefined;
  const [localDismissed, setLocalDismissed] = createSignal(false);
  const localNotice: Notice | undefined = deps.localNamed?.length
    ? {
        title: T("notice.localMachine.title"),
        text: T("notice.localMachine.text", {
          machines: deps.localNamed.join(", "),
        }),
        primary: {
          label: T("button.close"),
          run: () => setLocalDismissed(true),
        },
        dismiss: () => setLocalDismissed(true),
      }
    : undefined;
  let focusNotice:
    { err: { title: string; error: string }; notice: Notice } | undefined;

  /** 右下に積む知らせ。つながらない・別の GUI に移った・ワークスペースに移れなかった・ファイルを開けなかった。 */
  const notices = createMemo<Notice[]>(() => {
    const out: Notice[] = [];
    if (shortcutNotice && !shortcutDismissed()) out.push(shortcutNotice);
    if (localNotice && !localDismissed()) out.push(localNotice);
    const err = focusError();
    if (err) {
      if (focusNotice?.err !== err) {
        focusNotice = {
          err,
          notice: {
            title: err.title,
            error: err.error,
            primary: {
              label: T("button.close"),
              run: () => setFocusError(null),
            },
            dismiss: () => setFocusError(null),
          },
        };
      }
      out.push(focusNotice.notice);
    }
    for (const [t, st] of Object.entries(states())) {
      // 足している最中のマシンの失敗は、窓に出す
      if (!targets().includes(t)) continue;
      if (dismissed().has(st)) continue;
      if (!noticeOf.has(st)) noticeOf.set(st, makeNotice(t, st));
      const n = noticeOf.get(st);
      if (n) out.push(n);
    }
    // ダウンロード（#204）は最後に積む（リーダーの n d で、いちばん新しいものから閉じる）
    for (const d of downloads()) out.push(downloadNotice(d));
    return out;
  });

  /** マシン 1 台の状態の知らせ。知らせることが無ければ null。 */
  function makeNotice(t: string, st: SessionState): Notice | null {
    const label = labelOf(t);
    const close = {
      label: T("button.close"),
      run: () => setDismissed((d) => new Set(d).add(st)),
    };
    const cut = {
      label: T("button.disconnect"),
      run: () => void disconnect(t),
    };
    // ボタンと同じ動きのキー。マシンのダイアログ（リーダーの m）で、このマシンを選んで押す
    const leader = leaderKeyName(IS_MAC);
    const keys = T("notice.machine.keys", { leader });
    if (st.kind === "failed") {
      return {
        title: T("notice.machine.failed", { machine: label }),
        text: keys,
        error: st.message,
        secondary: [close, cut],
        dismiss: close.run,
        primary: { label: T("button.reconnect"), run: () => connect(t) },
      };
    }
    const failed = handoverFailure(label, st);
    if (failed) return { ...failed, primary: close, dismiss: close.run };
    if (st.kind === "superseded") {
      const who = st.by ? describeClient(st.by) : "";
      return {
        title: who
          ? T("notice.superseded.titleBy", { machine: label, who })
          : T("notice.superseded.title", { machine: label }),
        text: T("notice.superseded.text", { machine: label, keys }),
        secondary: [close, cut],
        dismiss: close.run,
        primary: { label: T("button.reconnect"), run: () => connect(t) },
      };
    }
    return null;
  }

  return notices;
}
