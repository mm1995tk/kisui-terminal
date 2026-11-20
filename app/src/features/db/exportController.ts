// DB のタブの結果の書き出し（#349）の操作。結果の表を CSV・TSV・JSON の文字にして、クリップボードかファイルに出す。
// 文字の作り方は export.ts。画面にも Tauri にも触らない（クリップボードと保存のダイアログは、渡された口で使う）。
import { T } from "../../i18n/index.ts";
import { createSignal, untrack } from "solid-js";

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import type { DbRef } from "../workspaces/model.ts";
import {
  exportExtension,
  exportFileName,
  exportText,
  isExportable,
  type ExportChoice,
  type SaveTextFile,
} from "./export.ts";

/** 書き出しの窓に出すもの。 */
export interface DbExportAsk {
  /** 書き出すタブ */
  tab: string;
  /** 結果の行数（窓の見出しに出す） */
  rows: number;
}

/** 書き出しの持ち物を作る。窓（どの形・どこへ）を開ける・決める・やめるを受け持つ。 */
export function createDbExport(deps: {
  refOf: (id: string) => DbRef | undefined;
  /** タブ id の最後の結果（無ければ undefined） */
  resultOf: (id: string) => DbQueryResult | undefined;
  /** 保存のダイアログを出して書く（features/db/export.ts の SaveTextFile） */
  saveFile: SaveTextFile;
  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す */
  copyToClipboard: (text: string) => Promise<void>;
  /** 少しの間だけ出る短い知らせ */
  showToast: (text: string) => void;
  /** 書き出せなかった理由の知らせ（見出しと本文） */
  fail: (title: string, text: string) => void;
  /** 今使っているペイン（DB のタブを出していれば SQL の入力欄）にキーを向ける */
  focusTerminal: () => void;
}) {
  const [ask, setAsk] = createSignal<DbExportAsk | null>(null);

  /** タブ id の結果を書き出す窓を出す。書き出せる結果が無ければ出さず false。 */
  function openExport(id: string): boolean {
    const r = deps.resultOf(id);
    if (!deps.refOf(id) || !isExportable(r)) return false;
    setAsk({ tab: id, rows: r.rowCount });
    return true;
  }

  /** 窓をやめる（キーを今のペインに戻す）。 */
  function closeExport() {
    setAsk(null);
    deps.focusTerminal();
  }

  /** 窓で決めた：窓を閉じて、その形でその書き出し先へ書き出す。 */
  async function chooseExport(c: ExportChoice) {
    const a = untrack(ask);
    setAsk(null);
    deps.focusTerminal();
    if (!a) return;
    const ref = deps.refOf(a.tab);
    const result = deps.resultOf(a.tab);
    if (!ref || !isExportable(result)) return;
    const text = exportText(result, c.format);
    if (c.target === "clipboard") {
      await deps.copyToClipboard(text);
      return;
    }
    try {
      const path = await deps.saveFile({
        defaultName: exportFileName(ref.connection, c.format),
        extension: exportExtension(c.format),
        text,
      });
      if (path !== null) deps.showToast(T("db.export.saved", { path }));
    } catch (e) {
      deps.fail(
        T("db.export.failed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return { exportAsk: ask, openExport, closeExport, chooseExport };
}
