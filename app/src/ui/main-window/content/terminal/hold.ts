// タブを切り替えたとき、前のタブの欄を、新しいタブの欄が描けるまで残す（TerminalGrid）。
// 新しい欄の coneko-term は、kisui serve から画面の状態（term.attach）が届いて書き終えるまで空（カーソルだけ）なので、
// その間は新しい欄を見せず、前の欄を前の位置のまま見せておく。新しい欄が全部描けたら、前の欄を外す。

/** 残している欄。外れたときの見た目（位置など）をそのまま持つ。 */
export interface Held<L, V> {
  link: L;
  view: V;
}

/**
 * 並びが prev から next に変わった（または、欄が描けた）ときに、残しておく欄を決める。
 * - next の欄が全部描けていれば、何も残さない。
 * - もう残している欄があれば、それ（next に戻ってきたものは除く）をそのまま残す。残している間に見えているのは
 *   残している欄で、prev の欄（まだ見せていない）ではないので、prev の欄は足さない。
 * - 何も残していなければ、prev から外れて描けていた欄を残す。描けていなかった欄は、残しても空なので足さない。
 * prev・next は、欄からその見た目への表（並びの順）。
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
