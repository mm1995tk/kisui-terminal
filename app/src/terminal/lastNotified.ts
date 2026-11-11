// 最後に OS の通知を出したペインを覚える（リーダーの `n g`。OS の通知を押したときと同じに、そのペインを前に出す）。
// 覚えるのは今画面にあるペインだけ。ペインがなくなったら（別のワークスペースへ移った・閉じた）忘れる。

let last: { id: symbol; focus: () => void } | undefined;

/** いま通知を出したペインを覚える。返す関数は、そのペインが無くなったときに呼ぶ（まだ最後のペインなら忘れる）。 */
export function rememberNotified(focus: () => void): () => void {
  const id = Symbol("notified");
  last = { id, focus };
  return () => {
    if (last?.id === id) last = undefined;
  };
}

/** 最後に通知を出したペインを前に出す。覚えていなければ何もせず false。 */
export function focusLastNotified(): boolean {
  if (!last) return false;
  last.focus();
  return true;
}
