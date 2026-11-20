// タブを切り替えたとき、前のタブのペインを、新しいタブのペインが描けるまで残す（TerminalGrid）。
// 新しいペインの coneko-term は、kisui serve から画面の状態（term.attach）が届いて書き終えるまで空（カーソルだけ）なので、
// その間は新しいペインを見せず、前のペインを前の位置のまま見せておく。新しいペインが全部描けたら、前のペインを外す。

/** 残しているペイン。外れたときの見た目（位置など）をそのまま持つ。 */
export interface Held<L, V> {
  link: L;
  view: V;
}

/**
 * 並びが prev から next に変わった（または、ペインが描けた）ときに、残しておくペインを決める。
 * - next のペインが全部描けていれば、何も残さない。
 * - もう残しているペインがあれば、それ（next に戻ってきたものは除く）をそのまま残す。残している間に見えているのは
 *   残しているペインで、prev のペイン（まだ見せていない）ではないので、prev のペインは足さない。
 * - 何も残していなければ、prev から外れて描けていたペインを残す。描けていなかったペインは、残しても空なので足さない。
 * prev・next は、ペインからその見た目への表（並びの順）。
 */
export function heldCells<L, V>(
  held: readonly Held<L, V>[],
  prev: ReadonlyMap<L, V>,
  next: ReadonlyMap<L, V>,
  drawn: (link: L) => boolean,
): Held<L, V>[] {
  if ([...next.keys()].every(drawn)) return [];
  if (held.length > 0) return held.filter((h) => !next.has(h.link));
  const keep: Held<L, V>[] = [];
  for (const [link, view] of prev) {
    if (next.has(link) || !drawn(link)) continue;
    keep.push({ link, view });
  }
  return keep;
}

/**
 * 残している間に使う、ペインのまわり（境界のつまみ・並べているか）を決める。
 * - 残すのをやめた（held が空）なら undefined（今のタブのまわりに戻す）。
 * - 残し始めた（前は空だった）なら、前のタブのまわり prevFrame を固める。
 * - 残している間は、固めたまわり prevHeldFrame を使い続ける。
 */
export function heldFrameOf<F>(
  prevHeld: readonly unknown[],
  held: readonly unknown[],
  prevFrame: F | undefined,
  prevHeldFrame: F | undefined,
): F | undefined {
  if (held.length === 0) return undefined;
  return prevHeld.length === 0 ? prevFrame : prevHeldFrame;
}
