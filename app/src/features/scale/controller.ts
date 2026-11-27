// 表示の大きさ（#594）の持ち物。覚えておいた大きさで始め、変えたら覚える（scale.ts）。
// 画面にも Tauri にも触らない。Dialog の zoom を変えるのは ApplyScale、変えた大きさを少しの間見せるのは showScale に頼む。
import type { KeyValueStore } from "../keyValueStore.ts";
import {
  loadScale,
  nextScale,
  saveScale,
  type ApplyScale,
  type ScaleAction,
} from "./scale.ts";

/** createScale が返す持ち物。 */
export type Scale = ReturnType<typeof createScale>;

/** 表示の大きさの持ち物を作る。覚えておいた大きさを Window に当て、変えるたびに覚える。 */
export function createScale(deps: {
  store: KeyValueStore | undefined;
  applyScale: ApplyScale;
  /** 変えた大きさを少しの間見せる */
  showScale: (v: number) => void;
}) {
  const { store, applyScale, showScale } = deps;
  // 表示の大きさ（#594）。覚えておいた大きさで始める
  let scale = loadScale(store);
  if (scale !== 1) void applyScale(scale);

  /** 表示の大きさを変える（#594）。Window 全体の zoom を変える。ターミナルは欄の変化で合わせ直す。 */
  function changeScale(a: ScaleAction) {
    scale = nextScale(scale, a);
    saveScale(store, scale);
    void applyScale(scale);
    showScale(scale);
  }

  return {
    /** 今の大きさ（1 が元の大きさ） */
    scale: () => scale,
    changeScale,
  };
}
