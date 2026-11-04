// IDE モードとターミナルモードの入れ替え（F3）。設計書 docs/design/gui-protocol.md の 6 章 F の表の F3。
//
// - IDE モードは、上が大きなファイルの欄、右下が小さなターミナル。ターミナルモードはその 2 枚のカードを
//   入れ替え、上が大きなターミナル、下が小さなファイルの欄になる。どちらのカードも隠さない（タブにしない）。
// - Ctrl+Shift+` で入れ替える。GUI が受けるキーなので shj にもシェルにも送らない。
// - 入れ替えは約 0.3 秒の動きにする（FLIP：先に割り付けを変え、前の位置と大きさから今のものへ動かす）。
//   割り付けはすぐ変わるので、ファイルの欄とターミナルの大きさ（view.resize・term.resize）もすぐ変わる。
//   カードは作り直さないので、中身は動き続ける。
// - IDE モードでも、フォーカスしているワークスペースでファイルを開いていない（ワークスペースが無いときも）
//   あいだは、ファイルの欄を出さず、右の列を全部ターミナルにする（親 #271 のモック U2）。ファイルを開いたら
//   上がファイルの欄・下がターミナルに戻る。ターミナルモードは、開いていなくても今のまま変えない。

import type { KeyLike } from "./files/input.ts";
import type { Files } from "./rpc/protocol.ts";

export type Mode = "ide" | "terminal";

/** 入れ替えにかける時間（ミリ秒）。 */
export const SWAP_MS = 300;

/**
 * IDE モードとターミナルモードを入れ替えるキー（Ctrl+Shift+`）か。
 * Shift を押すと key は "~" になる配列があり、JIS では ` が Shift+@ なので、code と key のどれかで見る。
 */
export function isModeKey(e: KeyLike): boolean {
  if (!isCtrlShift(e)) return false;
  return e.code === "Backquote" || e.key === "`" || e.key === "~";
}

/** Ctrl と Shift だけを押しているか（Alt・Meta は押していない）。GUI が受けるキーはどれもこの形。 */
export function isCtrlShift(e: KeyLike): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

/**
 * ファイルの欄にファイルを開いているか。shj は何も開いていないとき "welcome" のペインを 1 つだけ送る。
 * 画面がまだ来ていない（files が無い）ときも、開いていないとみなす。
 */
export function hasOpenFile(files: Files | null | undefined): boolean {
  return !!files?.panes.some((p) => p.kind !== "welcome");
}

/** もう一方のモード。 */
export function otherMode(m: Mode): Mode {
  return m === "ide" ? "terminal" : "ide";
}

/** 箱の位置と大きさ（DOMRect のうち使う項目）。 */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 今の箱（after）を前の箱（before）に重ねて見せる transform（左上を基点にする）。
 * 動かす必要が無いとき・大きさが 0 のときは null。
 */
export function flipTransform(before: Box, after: Box): string | null {
  if (after.width <= 0 || after.height <= 0) return null;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = before.width / after.width;
  const sy = before.height / after.height;
  if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return null;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

/**
 * change() で割り付けを変え、els を前の位置と大きさから今のものへ ms ミリ秒で動かす。
 * 動きを減らす設定（prefers-reduced-motion）なら動かさない。
 */
export function swapWithMotion(
  els: (HTMLElement | null | undefined)[],
  change: () => void,
  ms: number = SWAP_MS,
): void {
  const targets = els.filter((e): e is HTMLElement => !!e);
  const reduce = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  if (reduce) {
    change();
    return;
  }
  // 前の動きが残っていれば止めてから測る（途中の位置ではなく、割り付けの位置から始める）
  for (const el of targets) for (const a of el.getAnimations()) a.cancel();
  const before = targets.map((el) => el.getBoundingClientRect());
  change();
  targets.forEach((el, i) => {
    const t = flipTransform(before[i], el.getBoundingClientRect());
    if (!t) return;
    el.animate(
      [
        { transformOrigin: "top left", transform: t },
        { transformOrigin: "top left", transform: "none" },
      ],
      { duration: ms, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  });
}
