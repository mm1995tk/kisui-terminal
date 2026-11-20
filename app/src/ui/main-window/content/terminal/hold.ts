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
 * - そうでなければ、今残している欄（next に戻ってきたものは除く）に、prev から外れて描けていた欄を足す。
 *   描けていなかった欄は、残しても空なので足さない。
 * prev・next は、欄からその見た目への表（並びの順）。
 */
export function heldCells<L, V>(
  held: readonly Held<L, V>[],
  prev: ReadonlyMap<L, V>,
  next: ReadonlyMap<L, V>,
  drawn: (link: L) => boolean,
): Held<L, V>[] {
  if ([...next.keys()].every(drawn)) return [];
  const keep = held.filter((h) => !next.has(h.link));
  for (const [link, view] of prev) {
    if (next.has(link) || !drawn(link)) continue;
    if (keep.some((h) => h.link === link)) continue;
    keep.push({ link, view });
  }
  return keep;
}
