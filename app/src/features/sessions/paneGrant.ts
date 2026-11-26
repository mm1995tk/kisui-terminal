// ssh 先のマシンのペインに、手元の PC（local）のペインへの操作（kisui pane … --machine local）を、時間を決めて許す。
// 設計は docs/design/gui-protocol.md の「別のマシンのペイン」。画面にも Tauri にも触らない。
//
// 手元の PC にペインを作らせると、そのマシンは手元の PC でコマンドを動かせる。だから、設定ファイルでは許せない
// （[[gui.machines]] の allow_pane_to に local を書いても効かない。書いた許可は、書いたことを忘れても効き続けるため）。
// 許すのは、窓の前の人が、マシンのダイアログ（リーダーの m）の p で、時間を決めて始めたときだけ。時間が来ると戻り、
// P で途中で終えられる。許可は窓のメモリにだけ持つ（窓を閉じると消える。どこにも書かない）。
// 許している間も、手元の PC にペインを作る頼みは、そのたびに人に聞く（paneApproval.ts）。
import { createSignal } from "solid-js";

import { T } from "../../i18n/index.ts";

/** 時間の入力欄に、初めに入れておく値。 */
export const GRANT_DEFAULT = "30m";
/** 許せる時間の上限（秒）。8 時間。 */
export const GRANT_MAX_SECONDS = 8 * 60 * 60;

/**
 * 時間の書き方（"30m"・"1h"・"1h30m"・"90s"。DB の権限の引き上げと同じ書き方）を秒にする。
 * 読めない・0・上限（GRANT_MAX_SECONDS）より長いときは、理由を返す。
 */
export function parseGrantTime(
  text: string,
): { seconds: number } | { error: string } {
  const m = /^(?:(\d{1,4})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(
    text.trim().toLowerCase(),
  );
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined))
    return { error: T("paneGrant.err.format") };
  const seconds =
    Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (seconds <= 0) return { error: T("paneGrant.err.format") };
  if (seconds > GRANT_MAX_SECONDS) return { error: T("paneGrant.err.max") };
  return { seconds };
}

/** 残りの時間の字：1 分より短ければ秒（"45s"）、長ければ分に切り上げる（"12m"・"1h5m"）。 */
export function grantRemainingText(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** 終わる時刻の字（"23:45"。窓の時計）。お知らせに出す（毎秒変わらない字にするため、残りではなく時刻）。 */
export function grantUntilText(deadline: number): string {
  const d = new Date(deadline);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

// 許しているマシン（ssh の行き先）と、終わる時刻（窓の時計のミリ秒）
const [grants, setGrants] = createSignal<Record<string, number>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const enders = new Set<(target: string) => void>();

/** 今の許可（マシンの ssh の行き先 → 終わる時刻）。画面が読む。 */
export const paneGrants = grants;

/** マシン target に、今 (now) 許しているか。 */
export function paneGrantActive(target: string, now = Date.now()): boolean {
  const until = grants()[target];
  return until !== undefined && until > now;
}

/** 許可が終わったとき（時間が来た・途中で終えた）に呼ぶものを足す。聞いている途中の承認を取り下げるのに使う。外す関数を返す。 */
export function onPaneGrantEnd(fn: (target: string) => void): () => void {
  enders.add(fn);
  return () => enders.delete(fn);
}

/** マシン target の許可を終える（許していなければ何もしない）。 */
export function endPaneGrant(target: string): void {
  const t = timers.get(target);
  if (t !== undefined) clearTimeout(t);
  timers.delete(target);
  if (grants()[target] === undefined) return;
  setGrants((g) => {
    const { [target]: _, ...rest } = g;
    return rest;
  });
  for (const fn of [...enders]) fn(target);
}

/**
 * マシン target に、今 (now) から seconds 秒の間、手元の PC のペインへの操作を許す。もう許していれば、時間を今から数え直す。
 * 時間が来たら自分で終える。終わる時刻を返す。
 */
export function grantPanes(
  target: string,
  seconds: number,
  now = Date.now(),
): number {
  const until = now + seconds * 1000;
  const old = timers.get(target);
  if (old !== undefined) clearTimeout(old);
  timers.set(
    target,
    setTimeout(() => endPaneGrant(target), seconds * 1000),
  );
  setGrants((g) => ({ ...g, [target]: until }));
  return until;
}
