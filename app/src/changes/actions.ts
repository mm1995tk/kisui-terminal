// CHANGES の行のキーの操作（keys.ts の ChangesAction）を行う。DOM の行は引数で受ける。

import type { ChangesAction } from "./keys.ts";
import { moveIndex } from "./keys.ts";
import type { ChangeEntry } from "./model.ts";
import type { ChangesShjKey } from "../rpc/protocol.ts";

/** 一覧のそとへ頼むこと（shj・端末・エクスプローラは App が知っている）。 */
export interface ChangesHandlers {
  /** 変更の行を押した・開いた（path は ChangeRow.path） */
  onSelect: (path: string) => void;
  /** shj の CHANGES のキー（s・r・R・Space・: と Space の続き） */
  onShjKey?: (key: ChangesShjKey) => void;
  /** エクスプローラに移る（Tab） */
  onExplorer?: () => void;
  /** 端末に戻る（Esc・q） */
  onLeave?: () => void;
}

/** 操作が使うもの。 */
export interface ChangesContext extends ChangesHandlers {
  /** いま見えている行（上から順） */
  entries: () => readonly ChangeEntry[];
  /** 見えている行の要素（entries と同じ並び） */
  rowEls: () => HTMLElement[];
  /** フォルダを開く（true）・閉じる（false） */
  setFolder: (key: string, open: boolean) => void;
  /** Space を押した。続きの 1 文字を待つ */
  waitSpace: () => void;
}

/** 行 en（要素 el）で a をする。何かしたら true（ブラウザの既定の動き・スクロールを止める）。 */
export function runChangesAction(
  ctx: ChangesContext,
  en: ChangeEntry,
  el: HTMLElement,
  a: ChangesAction,
): boolean {
  switch (a.kind) {
    case "move": {
      // 端で動けなくても、↑ ↓ で一覧がスクロールしないように止める
      const els = ctx.rowEls();
      const next = els[moveIndex(ctx.entries(), els.indexOf(el), a.to)];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
      return true;
    }
    case "folder":
      ctx.setFolder(en.key, a.op === "toggle" ? !en.expanded : a.op === "open");
      return true;
    case "open":
      if (en.row) ctx.onSelect(en.row.path);
      return true;
    case "shj":
      if (!ctx.onShjKey) return false;
      if (a.key === "space") ctx.waitSpace();
      ctx.onShjKey(a.key);
      return true;
    case "explorer":
      if (!ctx.onExplorer) return false;
      ctx.onExplorer();
      return true;
    case "leave":
      if (!ctx.onLeave) return false;
      ctx.onLeave();
      return true;
  }
}
