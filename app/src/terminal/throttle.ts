// 続けて呼ばれる処理を間引く。最初の 1 回はすぐ実行し、間隔の間に来た分は、間隔が明けたとき 1 回にまとめて実行する
// （最後の呼び出しは必ず実行される）。サイドバーの幅をドラッグしている間、欄の列の数を測り直す頻度を抑えるのに使う。
// DOM を使わないので node --test で確かめられる。タイマーは差し替えられる。

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface Throttled {
  (): void;
  /** 待っている実行を取り消す。 */
  cancel(): void;
}

export function throttle(
  fn: () => void,
  ms: number,
  timers: Timers = realTimers,
): Throttled {
  let timer: unknown;
  let pending = false;
  const tick = () => {
    if (pending) {
      pending = false;
      fn();
      timer = timers.set(tick, ms);
    } else {
      timer = undefined;
    }
  };
  const call = (() => {
    if (timer === undefined) {
      fn();
      timer = timers.set(tick, ms);
    } else {
      pending = true;
    }
  }) as Throttled;
  call.cancel = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    pending = false;
  };
  return call;
}
