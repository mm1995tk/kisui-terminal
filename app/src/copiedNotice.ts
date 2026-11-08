// 「コピーしました」の短い表示。画面は CopiedToast.tsx、出して消す仕組みは timedNotice.ts。

/** コピーに成功したとき（write が true を返したとき）だけ「コピーしました」を出す。 */
export async function copyAndNotify(
  write: () => Promise<boolean>,
  notify: () => void,
): Promise<void> {
  if (await write()) notify();
}
