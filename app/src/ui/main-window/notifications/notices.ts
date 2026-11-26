// 右下に積む知らせを組み立てる（文とボタン）。つながらない・別の GUI に移った・できなかったこと・近道の間違い・使わない passkey_sites の項目・ダウンロード。
// 描くのは Notices.tsx。
import { T } from "../../../i18n/index.ts";
import { createMemo, createSignal, type Accessor } from "solid-js";

import type { Downloads } from "../../../features/browser/downloads.ts";
import type { DownloadDone } from "../../../features/browser/os.ts";
import { leaderKeyName } from "../../../features/commands/commands.ts";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import type { Problem, ReportProblem } from "../../../features/problem.ts";
import {
  localInAllowPaneTo,
  localNamed,
  unknownAllowPaneTo,
} from "../../../features/sessions/machines.ts";
import {
  endPaneGrant,
  grantUntilText,
  paneGrants,
} from "../../../features/sessions/paneGrant.ts";
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
  /** 設定の [gui.browser] passkey_sites の、公開サフィックスなので使わない項目（あればお知らせに出す） */
  passkeyRejected: string[] | undefined;
  /** できなかったこと（無ければ null） */
  focusError: Accessor<Problem | null>;
  setFocusError: ReportProblem;
  sessions: Pick<
    Sessions,
    "states" | "targets" | "labelOf" | "connect" | "disconnect" | "machines"
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
  // 名前が local のマシン（--machine で選べない）。閉じたら、同じ並びの間は出さない
  const [localDismissed, setLocalDismissed] = createSignal("");
  let localCache: { key: string; notice: Notice } | undefined;
  function localNotice(): Notice | undefined {
    const list = localNamed(deps.sessions.machines());
    const key = list.join("\n");
    if (list.length === 0 || localDismissed() === key) return undefined;
    if (localCache?.key !== key) {
      const close = () => setLocalDismissed(key);
      localCache = {
        key,
        notice: {
          title: T("notice.localMachine.title"),
          text: T("notice.localMachine.text", {
            machines: list.join(", "),
            leader: leaderKeyName(IS_MAC),
          }),
          primary: { label: T("button.close"), run: close },
          dismiss: close,
        },
      };
    }
    return localCache.notice;
  }
  // allow_pane_to に書いた、どのマシンの名前でもない語（書き間違い）。閉じたら、同じ並びの間は出さない
  const [allowPaneToDismissed, setAllowPaneToDismissed] = createSignal("");
  let allowPaneToCache: { key: string; notice: Notice } | undefined;
  function allowPaneToNotice(): Notice | undefined {
    const lines = unknownAllowPaneTo(deps.sessions.machines()).map(
      (u) => `${u.machine}: ${u.names.join(", ")}`,
    );
    const key = lines.join("\n");
    if (lines.length === 0 || allowPaneToDismissed() === key) return undefined;
    if (allowPaneToCache?.key !== key) {
      const close = () => setAllowPaneToDismissed(key);
      allowPaneToCache = {
        key,
        notice: {
          title: T("notice.allowPaneTo.title"),
          text: T("notice.allowPaneTo.text"),
          error: key,
          primary: { label: T("button.close"), run: close },
          dismiss: close,
        },
      };
    }
    return allowPaneToCache.notice;
  }
  // allow_pane_to に書いた local（効かない。手元の PC のペインの操作は、時間を決めて許す）。閉じたら、同じ並びの間は出さない
  const [allowLocalDismissed, setAllowLocalDismissed] = createSignal("");
  let allowLocalCache: { key: string; notice: Notice } | undefined;
  function allowLocalNotice(): Notice | undefined {
    const key = localInAllowPaneTo(deps.sessions.machines()).join(", ");
    if (key === "" || allowLocalDismissed() === key) return undefined;
    if (allowLocalCache?.key !== key) {
      const close = () => setAllowLocalDismissed(key);
      allowLocalCache = {
        key,
        notice: {
          title: T("notice.allowPaneToLocal.title"),
          text: T("notice.allowPaneToLocal.text", {
            leader: leaderKeyName(IS_MAC),
          }),
          error: key,
          primary: { label: T("button.close"), run: close },
          dismiss: close,
        },
      };
    }
    return allowLocalCache.notice;
  }
  // 手元の PC のペインの操作を、時間を決めて許している間の知らせ（マシンごと。許している間は出したままにし、閉じさせない。
  // 毎秒描き直さないよう、残りの時間ではなく終わる時刻を出し、終わる時刻が同じ間は同じオブジェクトを返す）
  const grantNotices = new Map<string, { until: number; notice: Notice }>();
  function grantNoticeList(): Notice[] {
    const granted = paneGrants();
    for (const t of [...grantNotices.keys()])
      if (granted[t] === undefined) grantNotices.delete(t);
    return Object.entries(granted).map(([target, until]) => {
      const had = grantNotices.get(target);
      if (had?.until === until) return had.notice;
      const notice: Notice = {
        title: T("notice.paneGrant.title", {
          machine: labelOf(target),
          until: grantUntilText(until),
        }),
        text: T("notice.paneGrant.text"),
        primary: {
          label: T("paneGrant.end"),
          run: () => endPaneGrant(target),
        },
      };
      grantNotices.set(target, { until, notice });
      return notice;
    });
  }
  const [passkeyDismissed, setPasskeyDismissed] = createSignal(false);
  const passkeyNotice: Notice | undefined = deps.passkeyRejected?.length
    ? {
        title: T("notice.passkeySites.title"),
        text: T("notice.passkeySites.text"),
        error: deps.passkeyRejected.join("\n"),
        primary: {
          label: T("button.close"),
          run: () => setPasskeyDismissed(true),
        },
        dismiss: () => setPasskeyDismissed(true),
      }
    : undefined;
  let focusNotice:
    { err: { title: string; error: string }; notice: Notice } | undefined;

  /** 右下に積む知らせ。つながらない・別の GUI に移った・ワークスペースに移れなかった・ファイルを開けなかった。 */
  const notices = createMemo<Notice[]>(() => {
    const out: Notice[] = [];
    if (shortcutNotice && !shortcutDismissed()) out.push(shortcutNotice);
    const local = localNotice();
    if (local) out.push(local);
    const allowPaneTo = allowPaneToNotice();
    if (allowPaneTo) out.push(allowPaneTo);
    const allowLocal = allowLocalNotice();
    if (allowLocal) out.push(allowLocal);
    out.push(...grantNoticeList());
    if (passkeyNotice && !passkeyDismissed()) out.push(passkeyNotice);
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
    // ダウンロード（#204）は最後に積む（リーダーの i d で、いちばん新しいものから閉じる）
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
