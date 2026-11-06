// shj につなぐ。殻に子プロセス（ssh か shj attach）を起動させ、その標準入出力を Client に載せ、
// session.hello を通す。

import { Client, type Transport } from "../rpc/client.ts";
import type { HelloResult } from "../rpc/protocol.ts";
import {
  EXIT_SHJ_MISSING,
  LOCAL,
  type ShellApi,
  type Unlisten,
} from "./api.ts";

export const GUI_NAME = "shijimi-editor-gui";
export const GUI_VERSION = "0.0.0";

export interface Connection {
  id: string;
  client: Client;
  hello: HelloResult;
  /** session.bye を送って閉じる（shj とシェルは止まらない）。 */
  close(): Promise<void>;
}

export class ConnectError extends Error {
  /** ssh / attach の標準エラー出力の最後の数行 */
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(stderr ? `${message}\n${stderr}` : message);
    this.name = "ConnectError";
    this.stderr = stderr;
  }
}

/**
 * リモートに shj が無い（ssh は通ったが、入れる場所に実行ファイルが無い）。
 * ユーザーに聞いてから入れる（設計書 3 章）。つなぎ直しを繰り返さず、聞く段階に進むための印。
 */
export class ShjMissingError extends ConnectError {
  constructor(stderr = "") {
    super("shj is not installed on the remote", stderr);
    this.name = "ShjMissingError";
  }
}

let counter = 0;
/** 接続（と入れる処理）の id。殻のイベントと、askpass の質問の宛先になる。 */
export function newId(): string {
  counter += 1;
  return `c${Date.now().toString(36)}-${counter}`;
}

/** 殻への書き込みを順番どおりにする（invoke は並べ替わりうる）。 */
function makeTransport(api: ShellApi, id: string): Transport {
  let tail: Promise<void> = Promise.resolve();
  return {
    write(text) {
      tail = tail.then(() => api.send(id, text)).catch(() => {});
    },
    close() {
      void api.disconnect(id).catch(() => {});
    },
  };
}

/**
 * target（ssh のホスト名か LOCAL）につなぎ、session.hello の結果まで進める。
 * 失敗したら ConnectError（ssh が出した標準エラー付き）。
 */
export async function connectShj(
  api: ShellApi,
  target: string,
  opts: {
    id?: string;
    /** つなぎ直し。同じ serverId なら shj の状態が残っている（設計書 3 章） */
    resume?: { serverId: string; rev: number };
    onDiscard?: (reason: string, line: string) => void;
  } = {},
): Promise<Connection> {
  const id = opts.id ?? newId();
  const unlisten: Unlisten[] = [];
  const cleanup = () => {
    for (const u of unlisten.splice(0)) u();
  };
  const transport = makeTransport(api, id);
  const client = new Client(transport, { onDiscard: opts.onDiscard });

  // 先に聞き始める（起動直後の出力を取りこぼさない）
  unlisten.push(
    await api.onLine((e) => {
      if (e.id === id) client.feed(e.line + "\n");
    }),
  );
  let stderr = "";
  let exitCode = null as number | null;
  unlisten.push(
    await api.onClosed((e) => {
      if (e.id !== id) return;
      stderr = e.stderr;
      exitCode = e.code;
      client.close(
        e.code == null
          ? "connection ended"
          : `connection ended (exit ${e.code})`,
      );
    }),
  );
  client.onClose(cleanup);

  try {
    await api.connect(id, target);
    const hello = await client.request("session.hello", {
      protocol: { major: 4, minor: 0 },
      client: { name: GUI_NAME, version: GUI_VERSION, kind: "web" },
      encoding: ["json"],
      ...(opts.resume ? { resume: opts.resume } : {}),
    });
    return {
      id,
      client,
      hello,
      async close() {
        try {
          await Promise.race([
            client.request("session.bye", {}),
            new Promise((r) => setTimeout(r, 1000)), // 返事が来なくても閉じる
          ]);
        } catch {
          // すでに切れている
        }
        client.close("closed by GUI");
      },
    };
  } catch (e) {
    // 閉じる通知より先に失敗が来ることがあるので、標準エラーが届くのを少し待つ
    if (!client.isClosed) client.close();
    await new Promise((r) => setTimeout(r, 0));
    const msg = e instanceof Error ? e.message : String(e);
    cleanup();
    // 終了コード 97 は、リモートのシェルが「shj が無い」と返したとき。ssh 自身の失敗（255 など）とは別。
    // LOCAL は ssh を挟まないので対象外
    if (target !== LOCAL && exitCode === EXIT_SHJ_MISSING) {
      throw new ShjMissingError(stderr);
    }
    throw new ConnectError(msg, stderr);
  }
}
