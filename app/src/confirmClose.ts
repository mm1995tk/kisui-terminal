// 「動いているプログラムを終わらせますか？」の窓の「終わらせて閉じる」（#162）。
// 依存は引数で受けるので、node --test で確かめられる。

export interface ConfirmClose {
  target: string;
  id: string;
  name: string;
}

/**
 * 窓を閉じる前に、閉じるワークスペースを取り出してから、force を付けて閉じ直す。
 * Solid の <Show> は、when が偽になったあとに子の accessor を読むと例外を投げる。
 * 窓を閉じた（状態を null にした）あとに c() を読むと、閉じる処理まで届かない。
 * そのため、呼ぶ側は accessor を読んだ値（read）を渡し、ここで先に取り出す。
 */
export function forceCloseWorkspace(
  read: () => ConfirmClose,
  dismiss: () => void,
  close: (target: string, id: string, force: boolean) => void,
): void {
  const { target, id } = read();
  dismiss();
  close(target, id, true);
}
