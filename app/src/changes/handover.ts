// CHANGES で shj のキーを押したあとの、キーの向け先の順番（#45）。
// kisui serve は要求を並べて処理し、term.input（端末のキー）は shj.changesKey と順番が保てない。
// space・: のあと端末にキーを向けるのは、shj.changesKey が通ってから（shj が「CHANGES の続き」を待つようになってから）にする。
// 先に向けると、続きのキー（space w の w など）が space より先に shj に届き、エディタのフォーカスならファイルに入る。

import type { ChangesShjKey } from "../rpc/protocol.ts";

/** 押したあとに端末へキーを向けるキー：続きのキーを端末から shj に打つもの。 */
export function continuesInTerminal(key: ChangesShjKey): boolean {
  return key === "space" || key === ":";
}

/**
 * shj.changesKey の要求 request（送り済み）の返事を待つ。通ったら、続きを端末に打つキーなら toTerminal を呼ぶ。
 * 断られたら toTerminal は呼ばず、fail を呼ぶ。返事が来るまでのキーは一覧に入る（ファイルは変わらない）。
 */
export function afterChangesKey(
  key: ChangesShjKey,
  request: Promise<unknown>,
  h: { toTerminal: () => void; fail: (e: unknown) => void },
): void {
  request.then(
    () => {
      if (continuesInTerminal(key)) h.toTerminal();
    },
    (e) => h.fail(e),
  );
}
