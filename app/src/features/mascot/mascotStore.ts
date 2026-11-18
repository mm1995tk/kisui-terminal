// 今使っているキャラクター（実験的。形式は docs/mascot.md）。窓を開いたときに 1 回読み、リーダーの `c r`（読み直す）と
// `c s`（選ぶ）で入れ替える。MascotCarrier.tsx が見て、App.tsx が入れ替える。
// 入れ替えても、今出している動きには関わらない（次にリーダーを開いたときから新しい絵になる）。
import { T } from "../../i18n/index.ts";
import { createSignal } from "solid-js";

import {
  loadMascot,
  reloadMascot,
  selectMascot,
  type LoadedMascot,
} from "./mascot.ts";

const [mascot, setMascot] = createSignal<LoadedMascot | null>(null);

/** 今使っているキャラクター（無ければ null） */
export { mascot };

/** 窓を開いたときに 1 回、設定で選んだキャラクターを読む */
export async function initMascot(): Promise<void> {
  setMascot(await loadMascot());
}

/** お知らせに出すこと（できなかった理由）。無ければ undefined（うまくいった） */
export type Failure = { title: string; error: string } | undefined;

/** `c r`：今選んでいるキャラクターを読み直す。読めなければ、前のキャラクターをそのまま使い、理由を返す */
export async function reloadCurrent(): Promise<Failure> {
  const r = await reloadMascot();
  switch (r.kind) {
    case "loaded":
      setMascot(r.mascot);
      return undefined;
    case "none":
      setMascot(null);
      return {
        title: T("mascot.err.noneTitle"),
        error: T("mascot.err.noneText"),
      };
    case "error":
      return { title: T("mascot.err.reload"), error: r.error };
  }
}

/** `c s` で選んだキャラクターを `config.local.toml` に書き、読み込む。書けなかった・読めなかったときは理由を返す */
export async function chooseMascot(name: string): Promise<Failure> {
  try {
    await selectMascot(name);
  } catch (e) {
    return { title: T("mascot.err.choose"), error: String(e) };
  }
  return reloadCurrent();
}
