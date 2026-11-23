// 窓の大きさ・フルスクリーンが変わったら、ページの場所が同じでも殻に送り直す（#326）。殻（macOS）は、ページの view を
// 画面の枠に合わせ直すのが、送られたときだけ。窓の形が変わった直後は、view の枠がまだ落ち着いていないことがあるので、
// 変わりが止まって少し待ってから、もう一度送る。

/** 変わりが止まってから、もう一度送るまでの待ち（ミリ秒） */
export const SETTLE_MS = [150, 500];

/**
 * 窓の `resize` を見張り始める。返す `take` は、送り直す要求があれば true を返して要求を消す。
 * `stop` で、リスナーとタイマーを外す。
 */
export function watchResize(
  target: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"
  > = window,
): {
  take: () => boolean;
  stop: () => void;
} {
  let want = false;
  let timers: number[] = [];
  const clear = () => {
    for (const t of timers) target.clearTimeout(t);
    timers = [];
  };
  const onResize = () => {
    want = true;
    clear();
    timers = SETTLE_MS.map((ms) => target.setTimeout(() => (want = true), ms));
  };
  target.addEventListener("resize", onResize);
  return {
    take: () => {
      const w = want;
      want = false;
      return w;
    },
    stop: () => {
      target.removeEventListener("resize", onResize);
      clear();
    },
  };
}
