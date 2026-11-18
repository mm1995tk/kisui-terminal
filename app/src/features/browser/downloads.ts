// 内蔵ブラウザのダウンロード（#204）の持ち物。~/Downloads に保存し、右下のお知らせで知らせる（知らせの文は ui/main-window/notifications/）。
// 画面にも Tauri にも触らない。殻への頼みは BrowserOs（os.ts）で受け取る。
import { T } from "../../i18n/index.ts";
import { createSignal, onCleanup, onMount } from "solid-js";

import type { ReportProblem } from "../problem.ts";
import type { BrowserOs, DownloadDone } from "./os.ts";

export type Downloads = ReturnType<typeof createDownloads>;

export function createDownloads(deps: {
  os: Pick<BrowserOs, "onDownload" | "openDownload" | "revealDownload">;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled） */
  browser: boolean;
  setFocusError: ReportProblem;
}) {
  const { setFocusError } = deps;
  const { onDownload, openDownload, revealDownload } = deps.os;
  /** 知らせているダウンロード（古い順。多すぎるときは古いものから消す） */
  const [downloads, setDownloads] = createSignal<DownloadDone[]>([]);
  function addDownload(d: DownloadDone) {
    setDownloads((l) => [...l, d].slice(-3));
  }
  const dropDownload = (d: DownloadDone) =>
    setDownloads((l) => l.filter((x) => x !== d));
  /** ダウンロードしたファイルを開く・フォルダを表示する。開けなければ知らせる。 */
  function useDownload(d: DownloadDone, how: "open" | "reveal") {
    (how === "open" ? openDownload(d.id) : revealDownload(d.id)).then(
      () => dropDownload(d),
      (e: unknown) =>
        setFocusError({
          title:
            how === "open"
              ? T("err.download.open", { name: d.name })
              : T("err.download.reveal", { name: d.name }),
          error: e instanceof Error ? e.message : String(e),
        }),
    );
  }
  /** いちばん新しい、保存できたダウンロード（リーダーの n o・n f が使う）。 */
  const lastDownload = () => [...downloads()].reverse().find((d) => d.ok);

  if (deps.browser) {
    let off: (() => void) | undefined;
    let gone = false;
    onCleanup(() => {
      gone = true;
      off?.();
    });
    onMount(async () => {
      off = await onDownload(addDownload);
      if (gone) off();
    });
  }

  return { downloads, dropDownload, useDownload, lastDownload };
}
