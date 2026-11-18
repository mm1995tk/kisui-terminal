// 今使っているキャラクター（実験的。形式は docs/mascot.md）。窓を開いたときに 1 回読み、リーダーの `c r`（読み直す）と
// `c s`（選ぶ）で入れ替える。MascotCarrier.tsx が見て、コマンド（features/commands/run.ts）が入れ替える。
// 入れ替えても、今出している動きには関わらない（次にリーダーを開いたときから新しい絵になる）。
import { T } from "../../i18n/index.ts";
import { createSignal, type Accessor } from "solid-js";

import {
  loadMascot,
  reloadMascot,
  type LoadedMascot,
  type MascotListing,
  type MascotOs,
} from "./mascot.ts";

/** お知らせに出すこと（できなかった理由）。無ければ undefined（うまくいった） */
export type Failure = { title: string; error: string } | undefined;

/** 今使っているキャラクターの持ち物（createMascotStore が返す）。 */
export interface MascotStore {
  /** 今使っているキャラクター（無ければ null） */
  mascot: Accessor<LoadedMascot | null>;
  /** 窓を開いたときに 1 回、設定で選んだキャラクターを読む */
  init(): Promise<void>;
  /** `c r`：今選んでいるキャラクターを読み直す。読めなければ、前のキャラクターをそのまま使い、理由を返す */
  reloadCurrent(): Promise<Failure>;
  /** `c s` で選んだキャラクターを `config.local.toml` に書き、読み込む。書けなかった・読めなかったときは理由を返す */
  choose(name: string): Promise<Failure>;
  /** `mascot/` の中のキャラクターの一覧と、今選んでいるもの */
  list(): Promise<MascotListing>;
}

/** キャラクターの持ち物を作る。os は Rust 側への頼み（index.tsx が本物を渡す）。 */
export function createMascotStore(os: MascotOs): MascotStore {
  const [mascot, setMascot] = createSignal<LoadedMascot | null>(null);

  async function init(): Promise<void> {
    setMascot(await loadMascot(os));
  }

  async function reloadCurrent(): Promise<Failure> {
    const r = await reloadMascot(os);
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

  async function choose(name: string): Promise<Failure> {
    try {
      await os.select(name);
    } catch (e) {
      return { title: T("mascot.err.choose"), error: String(e) };
    }
    return reloadCurrent();
  }

  return { mascot, init, reloadCurrent, choose, list: () => os.list() };
}
