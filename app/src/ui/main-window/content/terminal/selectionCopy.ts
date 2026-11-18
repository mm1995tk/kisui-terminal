/**
 * マウスで文字を選び終えた（離した）ときに、コピーするかを決める。
 * この欄で押して、押している間に選択が変わったときだけコピーする
 * （前からある選択を、クリックや右クリックの離したときに入れ直さない）。
 */
export class SelectionCopy {
  private pressed = false;
  private changed = false;

  /** この欄で押した。 */
  press(): void {
    this.pressed = true;
    this.changed = false;
  }

  /** 選択が変わった。 */
  selectionChanged(): void {
    if (this.pressed) this.changed = true;
  }

  /** 離した。コピーするなら true。 */
  release(): boolean {
    if (!this.pressed) return false;
    this.pressed = false;
    return this.changed;
  }
}
