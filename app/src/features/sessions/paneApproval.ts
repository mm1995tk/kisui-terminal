// ssh 先のマシンのペインが、手元の PC（local）のペインに頼んだこと（kisui pane … --machine local）を、窓の前の人に聞く。
// 聞くのは、人がそのマシンに時間を決めて許している間（paneGrant.ts）だけ。画面にも Tauri にも触らない。
//
// - ペインを作る頼み（open）は、そのたびに聞く。人は、作ったペインへのその後の操作を「聞かない」か「毎回聞く」かを選ぶ。
// - 「毎回聞く」と決めたペインと、そのペインから作られたペインへの send・keys・read・close（op）は、そのたびに聞く。
// 頼みの中身（コマンド・送る字）は、ssh 先が決めた字。どのマシンの頼みか（from）は、窓が接続から決めた名前で、別に出す。
import { createSignal } from "solid-js";

/** ペインを作る頼みへの答え：許す（以後聞かない）・許す（毎回聞く）・断る。 */
export type OpenDecision = "allow" | "allow-ask" | "deny";

/** 聞いている頼み 1 つ。id は、頼んだ serve の待ちの id（取り下げで使う）。from は頼んだマシン（ssh の行き先）。 */
export type PaneApproval = {
  id: string;
  from: string;
} & (
  | {
      kind: "open";
      /** 足す先のワークスペースの名前と、新しく作るか */
      workspace: string;
      isNew: boolean;
      /** 作るペインの名前 */
      name: string;
      /** 始めるフォルダ（無ければ、手元の PC の始めのフォルダ） */
      cwd: string;
      /** 動かすコマンド（空ならシェル） */
      argv: string[];
      resolve: (d: OpenDecision) => void;
    }
  | {
      kind: "op";
      cmd: "send" | "keys" | "read" | "close";
      /** 相手のペイン（名前、無ければ id） */
      pane: string;
      /** send の字 */
      text?: string;
      /** keys のキー */
      keys?: string[];
      resolve: (allowed: boolean) => void;
    }
);

const [queue, setQueue] = createSignal<PaneApproval[]>([]);

/** いま画面に出す頼み（先頭 1 つ。残りは順に出す）。 */
export const currentPaneApproval = () => queue()[0];

type OpenAsk = Omit<Extract<PaneApproval, { kind: "open" }>, "resolve">;
type OpAsk = Omit<Extract<PaneApproval, { kind: "op" }>, "resolve">;

/** ペインを作ってよいかを聞く。答えが決まるまで待つ（取り下げ・許可の終わりは「断る」）。 */
export function askPaneOpen(ask: OpenAsk): Promise<OpenDecision> {
  return new Promise<OpenDecision>((resolve) => {
    const entry: PaneApproval = {
      ...ask,
      resolve: (d: OpenDecision) => {
        setQueue((q) => q.filter((e) => e !== entry));
        resolve(d);
      },
    };
    setQueue((q) => [...q, entry]);
  });
}

/** ペインへの操作をしてよいかを聞く。答えが決まるまで待つ（取り下げ・許可の終わりは「断る」）。 */
export function askPaneOp(ask: OpAsk): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const entry: PaneApproval = {
      ...ask,
      resolve: (ok: boolean) => {
        setQueue((q) => q.filter((e) => e !== entry));
        resolve(ok);
      },
    };
    setQueue((q) => [...q, entry]);
  });
}

function refuse(e: PaneApproval): void {
  if (e.kind === "open") e.resolve("deny");
  else e.resolve(false);
}

/** 頼んだ serve が取り下げた頼み（pane.relayCancel。コマンドが止められた・時間切れ）を、断りとして片付ける。 */
export function cancelPaneApproval(from: string, id: string): void {
  for (const e of queue()) if (e.from === from && e.id === id) refuse(e);
}

/** マシン from の、聞いている途中の頼みを全部、断りとして片付ける（許可が終わった・接続が切れた）。 */
export function cancelPaneApprovalsFrom(from: string): void {
  for (const e of queue()) if (e.from === from) refuse(e);
}

// 「毎回聞く」と決めたペイン（手元の PC の serve の serverId と、ターミナルの id）
const askEach = new Set<string>();
const eachKey = (server: string, pane: string) => `${server}\n${pane}`;

/** 手元の PC のペイン pane（serve は server）を、「毎回聞く」ペインにする。 */
export function markAskEach(server: string, pane: string): void {
  askEach.add(eachKey(server, pane));
}

/** 「毎回聞く」ペインが 1 つでもあるか（無ければ、相手のペインを調べずに済む）。 */
export const anyAskEach = (): boolean => askEach.size > 0;

/**
 * 手元の PC のペイン pane と、そのペインを作った側（openedFrom。手元の PC のペインの id）のどれかが、「毎回聞く」ペインか。
 * 「毎回聞く」ペインから作られたペインも、毎回聞く（作らせたペインを通して、聞かれずに操作できないように）。
 */
export function mustAskEach(
  server: string,
  pane: string,
  openedFrom: readonly string[],
): boolean {
  return [pane, ...openedFrom].some((p) => askEach.has(eachKey(server, p)));
}

/** テスト用：覚えたものを全部捨てる。 */
export function resetPaneApprovals(): void {
  for (const e of queue()) refuse(e);
  askEach.clear();
}
