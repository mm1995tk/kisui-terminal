// 「動いているプログラムを終わらせますか？」の窓の「終わらせて閉じる」（#162）。
// 依存は引数で受けるので、node --test で確かめられる。

export interface ConfirmClose {
  target: string;
  id: string;
  name: string;
}

/**
 * 窓を閉じて、そのワークスペースを force を付けて閉じる。
 * 窓の状態（current）は、窓を閉じる（set で null にする）前に読む。
 * Solid の <Show> は、when が偽になったあとに子の accessor を読むと例外を投げるので、
 * 呼ぶ側は <Show> の accessor ではなく、窓の状態そのものを渡す。
 */
export function forceCloseWorkspace(
  current: () => ConfirmClose | null,
  set: (v: null) => void,
  close: (target: string, id: string, force: boolean) => void,
): void {
  const c = current();
  set(null);
  if (c) close(c.target, c.id, true);
}
