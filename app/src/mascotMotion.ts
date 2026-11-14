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
    const dx = window.innerWidth - el.getBoundingClientRect().left;
    const duration = walkDuration(dx);
    anim = el.animate?.(
      [{ transform: "none" }, { transform: `translateX(${dx}px)` }],
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
