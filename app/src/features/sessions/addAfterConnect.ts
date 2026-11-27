// `kisui machine add`（#514。controller.ts の addNow）の、つないでから書く手順。足す Dialog（controller.ts の submitAdd と、
// それを待つ effect）と同じ決まり：つながったら config.local.toml に書き、書けなければ切る。つなげない・取り下げられたときは、書かずに切る。
// ほかの所が先に切った（closed）ときは、切り直さない。もう接続がある行き先（足す Dialog がつないでいる最中など）には触らない。
// Solid にも Tauri にも触らない（node --test で確かめる）。

import { T } from "../../i18n/index.ts";
import type { SessionState } from "./session.ts";

/** 待つ相手の接続（Session のうち、ここが使うもの）。 */
export interface AddSession {
  readonly state: SessionState;
  onState(h: (s: SessionState) => void): () => void;
}

/** 決まった接続の状態（つながった・つなげなかった・ほかの所が切った）。 */
type Settled = Extract<
  SessionState,
  { kind: "connected" | "failed" | "superseded" | "closed" }
>;

const settled = (s: SessionState): s is Settled =>
  s.kind === "connected" ||
  s.kind === "failed" ||
  s.kind === "superseded" ||
  s.kind === "closed";

/** s の状態が決まるまで待つ。signal で取り下げられたら "aborted"（先に取り下げられていても）。 */
export function waitSettled(
  s: AddSession,
  signal: AbortSignal,
): Promise<Settled | "aborted"> {
  return new Promise((resolve) => {
    let finished = false;
    const done = (v: Settled | "aborted") => {
      if (finished) return;
      finished = true;
      off();
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const check = (x: SessionState) => {
      if (settled(x)) done(x);
    };
    const onAbort = () => done("aborted");
    const off = s.onState(check);
    signal.addEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
    else check(s.state);
  });
}

/** addAfterConnect が使うもの（controller.ts の持ち物）。 */
export interface AddDeps {
  /** 行き先に、もう接続があるか */
  hasSession(): boolean;
  /** 行き先につなぎ始め、その接続を返す */
  connect(): AddSession;
  /** 今の、行き先の接続（無ければ undefined） */
  current(): AddSession | undefined;
  /** config.local.toml に書く。書けなければ理由 */
  write(): Promise<string | undefined>;
  /** 行き先の接続を切る */
  disconnect(): void;
  /** 理由に出す、行き先の名前 */
  label: string;
  signal: AbortSignal;
}

/** つないでから書く。足せたら undefined、足せなければ理由。 */
export async function addAfterConnect(d: AddDeps): Promise<string | undefined> {
  if (d.hasSession()) return T("machine.err.connecting", { label: d.label });
  const s = d.connect();
  const st = await waitSettled(s, d.signal);
  if (st !== "aborted" && st.kind === "connected") {
    const err = await d.write();
    if (err !== undefined) d.disconnect();
    return err;
  }
  // 取り下げられた・つなげなかった。書かずに切る（ほかの所が先に切っていれば、切らない）
  if (d.current() === s) d.disconnect();
  if (st === "aborted" || st.kind === "closed")
    return T("machine.err.addCancelled");
  return st.kind === "failed"
    ? T("err.machine.connect", { machine: d.label, message: st.message })
    : T("err.machine.usedByOther", { machine: d.label });
}
