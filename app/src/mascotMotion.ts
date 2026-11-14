// キャラクター（MascotCarrier.tsx）が案内を運ぶ・一息つく・さようならをするときの、DOM とコマを動かす手続き。
// 始める関数は、止める関数を返す（タイマーとアニメーションを止める）。場面の状態は持たない。
import {
  pickVariant,
  playOnceDuration,
  restingScene,
  sceneFrame,
  travelDuration,
  type Mascot,
  type MascotScene,
} from "./mascot.ts";

/** コマを切り替えるかを確かめる間隔（ミリ秒） */
const TICK_MS = 30;

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
 * さようなら（startBye）を、今見えている位置で（移動せずに）始めるため、止めるときに覚えておく。
 */
const leftover = new WeakMap<HTMLElement, number>();

/** 速さ `speed`（px/秒）で運び始めて `elapsed` ミリ秒後に、運び終えた位置から左にずれている距離（px。0 以下）。速さが一定なので直線 */
export function carryOffset(
  dx: number,
  elapsed: number,
  speed: number,
): number {
  const duration = travelDuration(dx, speed);
  if (duration <= 0) return 0;
  const rest = Math.max(0, 1 - elapsed / duration);
  return rest === 0 ? 0 : -dx * rest;
}

/** `el` を止めた時点の、運び終えた位置からのずれ（px。0 以下）を取り出す（無ければ 0）。取り出したら忘れる */
export function takeOffset(el: HTMLElement | undefined): number {
  if (!el) return 0;
  const v = leftover.get(el) ?? 0;
  leftover.delete(el);
  return v;
}

/** 押していくとき、案内とキャラクターを動かす距離（px）。どちらも画面の右端（`viewportWidth`）の外へ出きるまで。`left` は、2 つのうち左にあるほうの左端 */
export function pushDistance(viewportWidth: number, left: number): number {
  return Math.max(0, viewportWidth - left);
}

/**
 * 場面 `scene` のコマを `onFrame` に知らせ続ける（くり返さない場面は最後のコマで止まる）。
 * `onDone` を渡すと、くり返しにかかわらず 1 回再生し終えたところで呼ぶ（さようなら）。
 */
export function startFrames(
  scene: MascotScene,
  onFrame: (frame: string) => void,
  onDone?: () => void,
): () => void {
  const t0 = performance.now();
  const once: MascotScene = onDone ? { ...scene, loop: false } : scene;
  onFrame(scene.frames[0]);
  const animated = scene.frames.length > 1;
  const tick = animated
    ? setInterval(
        () => onFrame(scene.frames[sceneFrame(once, performance.now() - t0)]),
        TICK_MS,
      )
    : undefined;
  const done = onDone
    ? setTimeout(() => {
        clearInterval(tick);
        onDone();
      }, playOnceDuration(scene))
    : undefined;
  return () => {
    clearInterval(tick);
    clearTimeout(done);
  };
}

/**
 * 一息つく場面から始め、待ち時間（`restAfterMs`）が経つと休憩の具体を 1 つ選んで動かす（`random` は 0 以上 1 未満を返す）。
 * くり返さない具体は、最後のコマのあと一息つく場面に戻り、また待ってから選び直す（前と同じ具体になることもある）。
 * くり返す具体は、止めるまでくり返す。休憩の具体が無ければ、一息つく場面のまま。
 */
export function startRest(
  m: Pick<Mascot, "carry" | "sigh" | "rest" | "restAfterMs">,
  onFrame: (frame: string) => void,
  random: () => number,
): () => void {
  let stopCurrent: () => void = () => {};
  let wait: ReturnType<typeof setTimeout> | undefined;
  const sigh = () => {
    stopCurrent();
    stopCurrent = startFrames(restingScene(m), onFrame);
    if (m.rest.length > 0) wait = setTimeout(rest, m.restAfterMs);
  };
  const rest = () => {
    const scene = pickVariant(m.rest, random());
    if (!scene) return;
    stopCurrent();
    stopCurrent = startFrames(scene, onFrame, scene.loop ? undefined : sigh);
  };
  sigh();
  return () => {
    clearTimeout(wait);
    stopCurrent();
  };
}

/**
 * 案内とキャラクターを、`dx` だけ左から今の位置まで、運ぶ場面の速さで動かす。コマを `onFrame` に知らせ、着いたら `onDone` を呼ぶ。
 * `char` は、`onFrame` で描画が出るまで無いことがあるので、アニメーションを始めるときに取る。
 */
export function startCarry(
  menu: HTMLElement,
  char: () => HTMLElement | undefined,
  dx: number,
  scene: MascotScene,
  onFrame: (frame: string) => void,
  onDone: () => void,
): () => void {
  const t0 = performance.now();
  const duration = travelDuration(dx, scene.speed);
  const anims: Animation[] = [];
  let live = true;
  const stopFrames = startFrames(scene, onFrame);
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
  const done = setTimeout(() => {
    stopFrames();
    onDone();
  }, duration);
  return () => {
    live = false;
    stopFrames();
    clearTimeout(done);
    // 動きを止めると位置が元に戻るので、先に今の位置を覚える
    const el = char();
    if (el)
      leftover.set(el, carryOffset(dx, performance.now() - t0, scene.speed));
    for (const a of anims) a.cancel();
  };
}

/**
 * さようなら: キャラクター（`char`）が、その場で（移動せずに）場面 `scene` を 1 回再生し、終えたら `onDone` を呼ぶ。
 * 運ぶ途中で閉じたときは、今見えている位置に留める。`interrupted` が true を返したら（ダイアログが開いたなど）、すぐ `onDone` を呼ぶ。
 */
export function startBye(
  char: () => HTMLElement | undefined,
  scene: MascotScene,
  onFrame: (frame: string) => void,
  onDone: () => void,
  interrupted: () => boolean,
): () => void {
  let live = true;
  const el = char();
  if (el) el.style.transform = `translateX(${takeOffset(el)}px)`;
  const finish = () => {
    if (!live) return;
    stop();
    onDone();
  };
  const stopFrames = startFrames(scene, onFrame, finish);
  // リーダーから開いたダイアログは、閉じた後の同じキーの処理の中で開く。その後で確かめる
  queueMicrotask(() => {
    if (interrupted()) finish();
  });
  const watch = setInterval(() => {
    if (interrupted()) finish();
  }, TICK_MS);
  const stop = () => {
    live = false;
    stopFrames();
    clearInterval(watch);
  };
  return stop;
}

/**
 * 押していく: 案内（`menu`。閉じた後も残してある写し）とキャラクターを、今の位置（運ぶ途中なら `from`。0 以下）から `dist` だけ右へ、
 * 場面 `scene` の速さで動かす。コマを `onFrame` に知らせ、動かし終えたら `onDone` を呼ぶ（止められたら呼ばない）。
 * 動かし終えたあとの片付け（写しを消す）は呼び出し側がする。
 */
export function startPush(
  menu: HTMLElement,
  char: () => HTMLElement | undefined,
  from: number,
  dist: number,
  scene: MascotScene,
  onFrame: (frame: string) => void,
  onDone: () => void,
): () => void {
  const duration = travelDuration(dist - from, scene.speed);
  const anims: Animation[] = [];
  let live = true;
  const stopFrames = startFrames(scene, onFrame);
  const keyframes = [
    { transform: `translateX(${from}px)` },
    { transform: `translateX(${dist}px)` },
  ];
  const opts = { duration, easing: "linear", fill: "forwards" } as const;
  // キャラクターの要素は、最初のコマが出てから現れるので、少し待って取る
  queueMicrotask(() => {
    if (!live) return;
    for (const el of [menu, char()]) {
      const a = el?.animate?.(keyframes, opts);
      if (a) anims.push(a);
    }
  });
  const done = setTimeout(() => {
    stopFrames();
    onDone();
  }, duration);
  return () => {
    live = false;
    stopFrames();
    clearTimeout(done);
    for (const a of anims) a.cancel();
  };
}
