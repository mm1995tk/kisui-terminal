// 1 つのワークスペースのターミナル 1 つと、それを描く画面（coneko-term）をつなぐ（F1）。
// 設計は docs/design/gui-protocol.md の 3 章「ターミナル」。
//
// - ターミナルは shj が作る（ワークスペースを作るとプライマリターミナルが、term.create で分割したターミナルができる）。
//   TermLink は termId を知った状態で作り、作る・拾う仕事はしない。
// - term.output は seq（バイト数の累計。そのかたまりの終わり）の順に画面へ書き、書き終えたら term.ack で返す。
//   shj は ack から 256 KiB より先を送らないので、画面が遅れると shj が待ち、`yes` のような大量の出力でも
//   画面が固まらない。
// - seq が飛んだ（溢れて捨てられた）とき・つなぎ直したときは、term.attach で画面の状態の書き出し
//   （画面・scrollback・モード。shj の中の coneko-term が持っている）を取り直す。過去の出力のバイト列は
//   流し直さない（そこに入っている端末への問い合わせに、こちらの coneko-term がもう一度返事をして、
//   シェルに文字が届いてしまうため）。書き出しを受け取ったら画面を reset してから書き、返事の seq より
//   先の term.output を続ける。返事を待つ間に届いた term.output は取っておき、返事のあとに seq で
//   つなぐ（seq 以前の分は書き出しに入っているので捨てる）。
// - プライマリターミナルのシェルが終わっても欄は閉じず、知らせを出して Enter で term.restart する
//   （ワークスペースのフォルダ、未定なら start_dir で始まる。termId はそのまま）。分割したターミナルのシェルが
//   終わったら、onExit で知らせる（並べた欄から外すため。F4）。
//
// DOM を使わないので node --test で確かめられる。画面は TermSink、shj は TermPort で差し替える。

import { ErrorCode, RpcError } from "../rpc/message.ts";
import type { Requests, TermId } from "../rpc/protocol.ts";
import type { TermEvent, TermMethod } from "../ssh/session.ts";

/** shj とのやりとり（Session が持つ）。 */
export interface TermPort {
  request<M extends TermMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]>;
  ackTerm(termId: TermId, seq: number): void;
}

/** 描く先（coneko-term）。 */
export interface TermSink {
  /** バイト列を書く。書き終えたら done を呼ぶ（coneko-term の write のコールバック）。 */
  write(data: Uint8Array, done: () => void): void;
  /** 知らせ（シェルの出力ではない文字）を書く。 */
  notice(text: string): void;
  /** 中身を消す（別のターミナルを描き始めるとき）。 */
  reset(): void;
}

/** 大きさが分からないうちの大きさ。 */
export const DEFAULT_SIZE = { cols: 80, rows: 24 };

/** シェルが終わったときに画面に出す知らせ。 */
export const EXITED_NOTICE =
  "\r\n[シェルが終わりました。Enter で新しいシェルを開きます]\r\n";

/**
 * ターミナル 1 つと、それを描く画面をつなぐ。ターミナル 1 つにつき 1 つ作り（並びは TermGroup が持つ）、
 * 欄に出すときに bind、外すときに unbind する。shj からの通知は handle に、つなぎ直したことは reconnected に渡す。
 * 流量制御・欠けの取り直し・つなぎ直しの決まりは、このファイルの先頭のとおり。
 */
export class TermLink {
  private readonly port: TermPort;
  private readonly onError: (message: string) => void;
  private sink?: TermSink;
  private readonly termId: TermId;
  /** ワークスペースのプライマリターミナルか（終わっても欄を閉じず、Enter で作り直す） */
  readonly primary: boolean;
  /** 画面に渡した分の seq（バイト数の累計） */
  private received = 0;
  /** attach の返事待ち。この間の term.output は取っておく（queued） */
  private attaching = false;
  /** attach の返事待ちの間に届いた term.output */
  private queued: { seq: number; data: Uint8Array }[] = [];
  /** 取り直した書き出しを画面が書き終えるまで。この間は次の取り直しを送らない */
  private restoring = false;
  /** restoring の間に欠けを見つけた。書き終えたら 1 回だけ取り直す */
  private gapPending = false;
  private exited = false;
  /** term.restart の返事待ち（Enter を続けて押しても 1 回だけ送る） */
  private restarting = false;
  private cols = DEFAULT_SIZE.cols;
  private rows = DEFAULT_SIZE.rows;
  /** 続けて始めたとき、古い返事を捨てるための番号 */
  private op = 0;
  /** 分割したターミナルのシェルが終わったと分かったとき（F4。並べた欄から外すため） */
  onExit?: () => void;

  constructor(
    port: TermPort,
    termId: TermId,
    onError: (message: string) => void = () => {},
    opts: { primary?: boolean } = {},
  ) {
    this.port = port;
    this.termId = termId;
    this.onError = onError;
    this.primary = opts.primary ?? false;
  }

  /** シェルが終わったか（Enter で作り直す前）。 */
  get hasExited(): boolean {
    return this.exited;
  }

  /** 描くターミナル。 */
  get id(): TermId {
    return this.termId;
  }

  /** 画面をつなぐ。画面の状態を取り直して続ける。つながっていないときは、つないだあと reconnected() で始まる。 */
  bind(sink: TermSink): void {
    this.sink = sink;
    sink.reset();
    this.received = 0;
    void this.open();
  }

  /** 画面を外す（畳んだ・別のマシンを出した）。シェルは止めない。 */
  unbind(): void {
    this.sink = undefined;
    this.nextOp();
  }

  /** つなぎ直した。画面の状態を取り直す。 */
  reconnected(): void {
    if (this.sink) void this.open();
  }

  /** 今の列と行（serve に知らせた最後の大きさ）。 */
  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** 画面の大きさが変わった。 */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    const id = this.termId;
    if (this.exited) return;
    this.port
      .request("term.resize", { termId: id, cols, rows })
      .catch((e) => this.failed("term.resize", id, e));
  }

  /** キー入力（coneko-term が作ったバイト列）。シェルが終わったあとの Enter で新しいシェルを開く。 */
  input(data: Uint8Array): void {
    const id = this.termId;
    if (this.exited) {
      if (this.primary && data.includes(13)) void this.restart();
      return;
    }
    // 取り直しの最中でも送る（PTY に書くだけで取り直しとは関係ない。`yes` を止める Ctrl+C を落とさない）
    this.port
      .request("term.input", { termId: id, data: encodeBase64(data) })
      .catch((e) => this.failed("term.input", id, e));
  }

  /** shj からの通知。 */
  handle(e: TermEvent): void {
    if (e.params.termId !== this.termId || !this.sink) return;
    switch (e.method) {
      case "term.output":
        this.output(e.params.seq, decodeBase64(e.params.data));
        return;
      case "term.exit":
        // 送り残した出力より先に届くことがあるので、画面の状態を取り直してから知らせる
        this.exited = true;
        void this.attach(this.op).then((r) => {
          if (!this.exited) return;
          if (r === "ok" && this.primary) this.sink?.notice(EXITED_NOTICE);
          if (!this.primary) this.onExit?.();
        });
        return;
      case "term.title":
        return; // F1 ではタイトルを出す場所が無い
    }
  }

  private output(seq: number, data: Uint8Array): void {
    if (this.attaching) {
      this.queued.push({ seq, data });
      return;
    }
    if (seq <= this.received) return;
    const start = seq - data.length;
    if (start > this.received) {
      // 溢れて捨てられた分がある。画面の状態を取り直す。前に取り直した分を画面が書き終える前なら、
      // 書き終えてから 1 回だけ取り直す（画面に積まれる量を「書き出し 1 回分 + ack の窓」までにする）
      if (this.restoring) this.gapPending = true;
      else void this.attach(this.op);
      return;
    }
    this.write(data.subarray(this.received - start), seq);
  }

  private write(data: Uint8Array, seq: number): void {
    const sink = this.sink;
    const id = this.termId;
    if (!sink) return;
    this.received = seq;
    const op = this.op;
    sink.write(data, () => {
      // 書き終えた分を返す（別のターミナルに移っていたら返さない）
      if (op === this.op && id === this.termId) this.port.ackTerm(id, seq);
    });
  }

  /** ターミナルにつなぎ、画面の状態を取り直す。 */
  private async open(): Promise<void> {
    const op = this.nextOp();
    const r = await this.attach(op);
    if (op !== this.op) return;
    const wasExited = this.exited;
    // 外している間・切れている間に終わったシェルは term.exit が届かないので、生きているかを確かめる
    if (r === "ok" && !wasExited) await this.checkAlive(op);
    if (op !== this.op) return;
    // 前から終わっていたものは、取り直して描き直した画面にもう一度出す（checkAlive で知ったときはそちらが出す）
    if (r === "ok" && wasExited && this.primary)
      this.sink?.notice(EXITED_NOTICE);
    // shj にターミナルが無い（shj が作り直された）。欄は、ワークスペースが一覧から消えるまで残る
    if (r === "missing") this.markExited();
  }

  /** シェルが終わったあと。プライマリターミナルは term.restart で同じ termId に新しいシェルを始める。 */
  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    const id = this.termId;
    const op = this.nextOp();
    try {
      await this.port.request("term.restart", { termId: id });
    } catch (e) {
      if (op === this.op) this.onError(`term.restart: ${message(e)}`);
      return;
    } finally {
      this.restarting = false;
    }
    if (op !== this.op) return;
    this.exited = false;
    await this.attach(op);
  }

  /**
   * 画面の状態の書き出しを取り直して、画面を reset してから書く。ターミナルが無ければ "missing"、
   * ほかの失敗と古い返事は "failed"。書き出しは shj が受け取ったものとみなす（seq までは ack を返さない）。
   */
  private async attach(op: number): Promise<"ok" | "missing" | "failed"> {
    const id = this.termId;
    this.attaching = true;
    this.queued = [];
    try {
      const r = await this.port.request("term.attach", { termId: id });
      if (op !== this.op) return "failed";
      this.attaching = false;
      const data = decodeBase64(r.snapshot);
      this.received = r.seq;
      const sink = this.sink;
      if (sink) {
        sink.reset();
        if (data.length > 0) {
          this.restoring = true;
          sink.write(data, () => {
            if (op !== this.op) return;
            this.restoring = false;
            if (this.gapPending) {
              this.gapPending = false;
              void this.attach(op);
            }
          });
        }
      }
      // 返事を待つ間に届いた出力のうち、書き出しのあとの分をつなぐ
      const queued = this.queued;
      this.queued = [];
      for (const q of queued) this.output(q.seq, q.data);
      return "ok";
    } catch (e) {
      if (op !== this.op) return "failed";
      this.attaching = false;
      this.queued = [];
      if (e instanceof RpcError && e.code === ErrorCode.NotFound)
        return "missing";
      this.onError(`term.attach: ${message(e)}`);
      return "failed";
    }
  }

  /** 古い返事と書き終わりを捨てるため、番号を進めて取り直しの状態を戻す。 */
  private nextOp(): number {
    this.attaching = false;
    this.queued = [];
    this.restoring = false;
    this.gapPending = false;
    return ++this.op;
  }

  /** シェルが終わったことにして知らせる（もう知っていれば何もしない）。 */
  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    if (this.primary) this.sink?.notice(EXITED_NOTICE);
    else this.onExit?.();
  }

  /** つないだターミナルが term.list で生きているかを確かめ、終わっていれば知らせる。 */
  private async checkAlive(op: number): Promise<void> {
    const id = this.termId;
    try {
      const { terms } = await this.port.request("term.list", {});
      if (op !== this.op) return;
      const t = terms.find((t) => t.termId === id && t.alive);
      if (!t) this.markExited();
      // 別の大きさの画面で使っていたターミナルに切り替えたときは、こちらの大きさに合わせる
      else this.sendSize(t.cols, t.rows);
    } catch (e) {
      if (op === this.op) this.onError(`term.list: ${message(e)}`);
    }
  }

  /** term.input・term.resize が失敗した。not_found はシェルが終わったもの（term.exit を受け損ねた）。 */
  private failed(method: string, id: TermId, e: unknown): void {
    if (e instanceof RpcError && e.code === ErrorCode.NotFound) {
      this.markExited();
      return;
    }
    this.onError(`${method}: ${message(e)}`);
  }

  /** つないだターミナルの大きさが画面と違えば合わせる。 */
  private sendSize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.port
      .request("term.resize", {
        termId: this.termId,
        cols: this.cols,
        rows: this.rows,
      })
      .catch((e) => this.onError(`term.resize: ${message(e)}`));
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** バイト列を base64 にする（term.input の data）。 */
export function encodeBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000)
    s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

/** base64 をバイト列に戻す（term.output の data、term.attach の snapshot）。 */
export function decodeBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
