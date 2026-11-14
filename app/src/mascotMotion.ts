// キャラクター（MascotCarrier.tsx）が案内を運ぶ・去るときの、DOM を動かす手続き。
// 始める関数は、止める関数を返す（タイマーとアニメーションを止める）。場面の状態は持たない。
import { walkDuration, walkFrame } from "./mascot.ts";

/** 案内（`menu`）を、サイドバーの右端にキャラクターの幅（`width`）を足した位置から今の位置まで運ぶときの、動かす距離（px） */
export function carryDistance(menu: HTMLElement, width: number): number {
  const sidebarRight =
    document.querySelector(".sidebar-column")?.getBoundingClientRect().right ??
    0;
  return Math.max(
    0,
    menu.getBoundingClientRect().left - (sidebarRight + width),
  );
}

/**
 * 運ぶ動きを止めた時点で、キャラクターが運び終えた位置から左にずれていた距離（px。0 以下）。
 * 去る動き（startLeave）が、今見えている位置から始められるように、止めるときに覚えておく。
 */
const leftover = new WeakMap<HTMLElement, number>();

/** 運び始めて `elapsed` ミリ秒後に、運び終えた位置から左にずれている距離（px。0 以下）。速さが一定なので直線 */
export function carryOffset(dx: number, elapsed: number): number {
  const duration = walkDuration(dx);
  if (duration <= 0) return 0;
  const rest = Math.max(0, 1 - elapsed / duration);
  return rest === 0 ? 0 : -dx * rest;
}

/**
 * 案内とキャラクターを、`dx` だけ左から今の位置まで動かす。歩きのコマを `onFrame` に知らせ、着いたら `onDone` を呼ぶ。
 * `char` は、`onFrame` で描画が出るまで無いことがあるので、アニメーションを始めるときに取る。
 */
export function startCarry(
  menu: HTMLElement,
  char: () => HTMLElement | undefined,
  dx: number,
  onFrame: (frame: number) => void,
  onDone: () => void,
): () => void {
  const t0 = performance.now();
  const duration = walkDuration(dx);
  const anims: Animation[] = [];
  let live = true;
  onFrame(0);
  queueMicrotask(() => {
    if (!live) return;
    const keyframes = [
      { transform: `translateX(${-dx}px)` },
      { transform: "none" },
    ];
    const opts = { duration, easing: "linear" } as const;
    for (const el of [menu, char()]) {
      const a = el?.animate?.(keyframes, opts);
      if (a) anims.push(a);
    }
  });
  const tick = setInterval(
    () => onFrame(walkFrame(performance.now() - t0)),
    30,
  );
  const done = setTimeout(() => {
    clearInterval(tick);
    onDone();
  }, duration);
  return () => {
    live = false;
    clearInterval(tick);
    clearTimeout(done);
    // 動きを止めると位置が元に戻るので、先に今の位置を覚える
    const el = char();
    if (el) leftover.set(el, carryOffset(dx, performance.now() - t0));
    for (const a of anims) a.cancel();
  };
}

/** キャラクター（`char`）が、歩きのコマで右へ歩いて去る（運ぶときと同じ速さ）。歩きのコマを `onFrame` に知らせ、去り終えたら `onDone` を呼ぶ */
export function startLeave(
  char: () => HTMLElement | undefined,
  onFrame: (frame: number) => void,
  onDone: () => void,
): () => void {
  const t0 = performance.now();
  let live = true;
  let tick: ReturnType<typeof setInterval> | undefined;
  let done: ReturnType<typeof setTimeout> | undefined;
  let anim: Animation | undefined;
  onFrame(0);
  queueMicrotask(() => {
    const el = char();
    if (!live || !el) return;
    // 運ぶ途中で閉じたときは、今見えている位置（運び終えた位置から `from` だけ左）から歩く
    const from = leftover.get(el) ?? 0;
    leftover.delete(el);
    const dx = window.innerWidth - (el.getBoundingClientRect().left + from);
    const duration = walkDuration(dx);
    anim = el.animate?.(
      [
        { transform: `translateX(${from}px)` },
        { transform: `translateX(${from + dx}px)` },
      ],
      { duration, easing: "linear" },
    );
    tick = setInterval(() => onFrame(walkFrame(performance.now() - t0)), 30);
    done = setTimeout(() => {
      clearInterval(tick);
      onDone();
    }, duration);
  });
  return () => {
    live = false;
    clearInterval(tick);
    clearTimeout(done);
    anim?.cancel();
  };
}
