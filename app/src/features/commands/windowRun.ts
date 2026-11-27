// Window に頼む、Pane の中のコマンド（`kisui tab` など。#511）の受け口。
// serve の window.run（行うことの名前 command と、その引数 args）を受け、その名前の受け持ち（WindowCommandHandler）に渡して、
// 答え（window.ran）にする。答えを送るのは呼ぶ側（workspaces/paneEvents.ts）。画面にも Tauri にも触らない。
//
// command は Command の id（commands.ts の CommandId）と同じ形の名前。キー操作の Command は「今出しているもの」に効くが、
// CLI は相手を引数で指すので、Command の id をそのまま動かす（runCommand）のではなく、名前ごとに受け持ちを書く。
// Command の無いもの（一覧を返す "tab.list" など）も同じ形の名前にする。
//
// CLI を足すとき：機能の側に WindowCommandTable（名前 → 受け持ち）を作り、compose.ts で createWindowRun に渡す。serve は変えない。
// window.run は頼んだ Machine の serve が作る通知なので、リモートの Machine を自由にできる者は、kisui を通さずにどんな中身でも
// 送れる。だから受け持ちは、既定では手元の PC の Pane の頼みだけを受ける（ほかは createWindowRun が断る）。リモートの Machine の
// Pane の頼みも受ける受け持ちは remote: true を書き、caller.from（通知を送ってきた serve の Machine。Window が接続から決める）と
// 手元の設定だけで、届いてよいかを決める（sessions/machines.ts の windowReachAllowed）。args は、型を確かめてから使う（argString など）。
import { T } from "../../i18n/index.ts";
import { LOCAL } from "../sessions/shell.ts";
import type {
  WindowRunReport,
  WindowRunRequest,
} from "../../infrastructure/rpc/protocol.ts";

/** 頼んだ側。 */
export interface WindowCaller {
  /** 頼みの通知を送ってきた serve の Machine（ssh の行き先。手元の PC は LOCAL）。届く範囲は、これで決める */
  from: string;
  /** 頼んだ Pane の id（from の serve でのもの。serve が言った値） */
  pane: string;
  /** 頼んだ Pane の Terminal tab（from の serve のワークスペースの id。serve が言った値） */
  tab: string;
  /** serve が答えを待つのをやめたら終わる（人に聞いている途中なら、聞くのをやめる） */
  signal: AbortSignal;
}

/** 受け持ちが断るときに投げる。message はそのままコマンドが出す。code は、コマンドが見分ける断り（serve の panecmd.Reply.Code）。 */
export class WindowCommandError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "WindowCommandError";
    if (code !== undefined) this.code = code;
  }
}

/** プログラムが動いているので閉じなかった（コマンドは --force を案内する）。serve の panecmd.CodeBusy。 */
export const CODE_BUSY = "busy";

/** 1 つの名前の受け持ち。返した値が、そのまま result になる（JSON にできる値）。断るときは WindowCommandError を投げる。 */
export type WindowCommandHandler = (
  args: Record<string, unknown>,
  caller: WindowCaller,
) => unknown;

/** 名前 1 つの受け持ちと、どの Machine の Pane の頼みを受けるか。 */
export interface WindowCommand {
  run: WindowCommandHandler;
  /**
   * true なら、リモートの Machine の Pane の頼みも run に渡す。run は caller.from で、届いてよいかを自分で確かめる。
   * 書かなければ、手元の PC の Pane の頼みだけを受け、ほかは createWindowRun が断る（確かめ忘れた受け持ちが、
   * リモートの Machine に開かないよう、既定で閉じる）。
   */
  remote?: true;
}

/** 名前（"tab.rename"）→ 受け持ち。 */
export type WindowCommandTable = Readonly<Record<string, WindowCommand>>;

/** args の文字の引数 name。無い・文字でなければ断る。 */
export function argString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string")
    throw new WindowCommandError(T("windowRun.err.arg", { name }));
  return v;
}

/** args の、あっても無くてもよい文字の引数 name。文字でなければ断る。 */
export function argOptionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  return args[name] === undefined ? undefined : argString(args, name);
}

/** args の、あっても無くてもよい真偽の引数 name（無ければ false）。真偽でなければ断る。 */
export function argFlag(args: Record<string, unknown>, name: string): boolean {
  const v = args[name];
  if (v !== undefined && typeof v !== "boolean")
    throw new WindowCommandError(T("windowRun.err.arg", { name }));
  return v === true;
}

/** window.run を受けて行う関数を作る。tables は、機能ごとの受け持ちの表（同じ名前が 2 つの表にあれば、作るときに投げる）。 */
export function createWindowRun(tables: readonly WindowCommandTable[]) {
  const handlers = new Map<string, WindowCommand>();
  for (const t of tables)
    for (const [name, h] of Object.entries(t)) {
      if (handlers.has(name))
        throw new Error(`window command ${name} has two handlers`);
      handlers.set(name, h);
    }
  // 答えを待っている頼み（Machine と頼みの id → 取り下げ）
  const running = new Map<string, AbortController>();
  const keyOf = (from: string, id: string) => JSON.stringify([from, id]);

  return {
    /** Machine from の serve の頼み rq を行い、答えを返す（投げない。行えなければ error に理由）。 */
    async run(from: string, rq: WindowRunRequest): Promise<WindowRunReport> {
      const h = handlers.get(rq.command);
      if (!h)
        return { error: T("windowRun.err.unknown", { command: rq.command }) };
      if (from !== LOCAL && !h.remote)
        return {
          error: T("windowRun.err.localOnly", { command: rq.command }),
        };
      const abort = new AbortController();
      const key = keyOf(from, rq.id);
      running.set(key, abort);
      try {
        const result = await h.run(rq.args, {
          from,
          pane: rq.pane,
          tab: rq.tab,
          signal: abort.signal,
        });
        return { result: result ?? {} };
      } catch (e) {
        if (e instanceof WindowCommandError)
          return e.code === undefined
            ? { error: e.message }
            : { error: e.message, code: e.code };
        return { error: e instanceof Error ? e.message : String(e) };
      } finally {
        running.delete(key);
      }
    },
    /** Machine from の serve が、頼み id を取り下げた。 */
    cancel(from: string, id: string): void {
      running.get(keyOf(from, id))?.abort();
    },
  };
}
