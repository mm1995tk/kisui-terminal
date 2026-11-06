// 「コピーしました」の短い表示。画面は CopiedToast.tsx。

/** 表示が出ている時間（ミリ秒） */
export const COPIED_VISIBLE_MS = 1500;

/**
 * 出して、しばらくしたら自分で消す（押して閉じる必要は無い）。
 * 表示を出す条件（書けたときだけ）は呼ぶ側が決める（copyAndNotify）。
 */
export class CopiedNotice {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly set: (visible: boolean) => void;
  private readonly ms: number;

  constructor(set: (visible: boolean) => void, ms = COPIED_VISIBLE_MS) {
    this.set = set;
    this.ms = ms;
  }

  /** 出す。出ている間にもう一度呼ぶと、そこから数え直す。 */
  show(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.set(true);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.set(false);
    }, this.ms);
  }
}

/** コピーに成功したとき（write が true を返したとき）だけ「コピーしました」を出す。 */
export async function copyAndNotify(
  write: () => Promise<boolean>,
  notify: () => void,
): Promise<void> {
  if (await write()) notify();
}
