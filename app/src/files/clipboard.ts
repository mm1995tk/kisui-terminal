// OS のクリップボード（E2）。shj の clipboard.write を OS のクリップボードに入れ、貼り付けのキーで読む。
//
// Web のクリップボード（navigator.clipboard）は、ユーザーの操作の中でないと断られることがある
// （WebKit は、キーを押したその場の処理の中でだけ書かせる）。clipboard.write は shj から遅れて届くので、
// 断られたら覚えておき、次にユーザーがキーかマウスを押したとき（flush）に書き直す。
// 覚えている間に貼り付けのキーを押したら、その文字を貼る（OS のクリップボードはまだ古いので）。
// ウィンドウがフォーカスを失ったら捨てる（ほかのアプリでコピーされうるので、もう新しいとは言えない）。

/** navigator.clipboard のうち、ここで使うもの（テストで差し替える）。 */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

/**
 * OS のクリップボード。write で書き、断られたら覚えて flush で書き直す。read は貼り付ける文字を返す。
 * ウィンドウがフォーカスを失ったら discard を呼ぶ。
 */
export class OsClipboard {
  private readonly cb: () => ClipboardLike | undefined;
  private readonly onError: (e: unknown) => void;
  /** 書けなかった文字（次の操作で書き直す） */
  private pending?: string;

  constructor(
    cb: () => ClipboardLike | undefined,
    onError: (e: unknown) => void = () => {},
  ) {
    this.cb = cb;
    this.onError = onError;
  }

  /** text を OS のクリップボードに入れる。断られたら覚えておく。 */
  async write(text: string): Promise<void> {
    this.pending = text;
    await this.flush();
  }

  /** 書けていない文字（OS のクリップボードより新しい）。無ければ undefined。 */
  get unwritten(): string | undefined {
    return this.pending;
  }

  /** 書けていない文字を捨てる（ウィンドウがフォーカスを失ったとき。ほかのアプリの内容を上書きしないように）。 */
  discard(): void {
    this.pending = undefined;
  }

  /** 書けていない文字があれば、もう一度書く（ユーザーの操作の中で呼ぶ）。 */
  async flush(): Promise<void> {
    const text = this.pending;
    const cb = this.cb();
    if (text === undefined || !cb) return;
    try {
      await cb.writeText(text);
      if (this.pending === text) this.pending = undefined;
    } catch (e) {
      this.onError(e);
    }
  }

  /** 貼り付ける文字。書けていない文字があればそれ、なければ OS のクリップボードを読む。読めなければ ""。 */
  async read(): Promise<string> {
    if (this.pending !== undefined) {
      const text = this.pending;
      void this.flush();
      return text;
    }
    const cb = this.cb();
    if (!cb) return "";
    try {
      return await cb.readText();
    } catch (e) {
      this.onError(e);
      return "";
    }
  }
}
