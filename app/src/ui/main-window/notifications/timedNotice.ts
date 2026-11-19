// 少しの間だけ出て、自分で消える表示。「コピーしました」（CopiedToast.tsx）と表示の大きさ（ScaleToast.tsx）が使う。

/** 表示が出ている時間（ミリ秒） */
export const NOTICE_VISIBLE_MS = 1500;

/**
 * 出して、しばらくしたら自分で消す（押して閉じる必要は無い）。
 * 表示を出す条件は呼ぶ側が決める。
 */
export class TimedNotice {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly set: (visible: boolean) => void;
  private readonly ms: number;

  constructor(set: (visible: boolean) => void, ms = NOTICE_VISIBLE_MS) {
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
