// `kisui pane … --machine`（#344）：別のマシンのペインへの頼みの中継。
// serve はマシンごとに 1 つで、自分のマシンのペインしか知らない。GUI は全部のマシンの serve につながっているので、
// 頼まれた serve の pane.relay を受け、名前（[[gui.machines]] の名前。local は手元の PC）のマシンの serve に pane.run で送る。
// open-tab（kisui pane open）は、pane.open と同じく GUI がそのマシンにタブを作る（openTab）。
// 答え（pane.relayed）は呼ぶ側が送る。画面にも Tauri にも触らない。
//
// pane.relay は頼んだマシンの serve が作る通知なので、ssh 先のマシンのものは、手元の設定で許した先にだけ中継する
// （そのマシンの `allow_pane_to`。machines.ts の paneRelayAllowed）。手元の PC の serve のものは、どのマシンにも中継する。
//
// ssh 先のマシンから手元の PC（local）への頼みは、設定では許せない。Window の前の人が、そのマシンに時間を決めて許している間
// （paneGrant.ts）だけ中継し、ペインを作る頼みは、そのたびに人に聞く（paneApproval.ts）。人が「毎回聞く」と決めたペインと、
// そこから作られたペインへの send・keys・read・close も、そのたびに聞く。
import { untrack } from "solid-js";

import { T } from "../../i18n/index.ts";
import type {
  PaneOpenReport,
  PaneOpenRequest,
  PaneOrigin,
  PaneRunReply,
  PaneRunRequest,
} from "../../infrastructure/rpc/protocol.ts";
import type { Sessions } from "./controller.ts";
import { machineNames, machineTarget, paneRelayAllowed } from "./machines.ts";
import type { OpenDecision, PaneApproval } from "./paneApproval.ts";
import { LOCAL } from "./shell.ts";

/** 人に聞かない頼みで、相手のマシンの答えを待つ時間（ミリ秒）。過ぎたら、理由を付けて断る。 */
export const RELAY_WAIT_MS = 8000;

/**
 * ssh 先のマシンから手元の PC への頼みを通すかを決めるもの（本物は paneGrant.ts と paneApproval.ts。compose.ts が渡す）。
 * 渡さなければ、ssh 先のマシンから手元の PC へは中継しない。
 */
export interface LocalGate {
  /** マシン from に、今、時間を決めて許しているか */
  granted(from: string): boolean;
  /** ペインを作ってよいかを人に聞く */
  askOpen(
    ask: Omit<Extract<PaneApproval, { kind: "open" }>, "resolve">,
  ): Promise<OpenDecision>;
  /** ペインへの操作をしてよいかを人に聞く */
  askOp(
    ask: Omit<Extract<PaneApproval, { kind: "op" }>, "resolve">,
  ): Promise<boolean>;
  /** 「毎回聞く」ペインが 1 つでもあるか */
  anyAskEach(): boolean;
  /** 手元の PC のペイン pane か、それを作った側（openedFrom）が「毎回聞く」ペインか */
  mustAskEach(
    server: string,
    pane: string,
    openedFrom: readonly string[],
  ): boolean;
  /** 手元の PC のペイン pane を「毎回聞く」ペインにする */
  markAskEach(server: string, pane: string): void;
}

/**
 * マシン from のペイン pane を、相手の serve に名乗る名前。serve は、この名前のペインが作ったペインと、その先にだけ届かせる
 * （server/panereach.go）。どの serve のペインかは、Window が from の接続から決める（頼みの通知に書いてあっても使わない）。
 * serverId は serve が自分で言う値なので、ssh 先の serve は、ほかのマシンの serverId を言える。だから、ssh 先のマシン from の
 * serverId が、つないでいるほかのマシンのものと同じなら、名乗らない（ほかのマシンのペインになりすませないように、どこにも
 * 届かせない）。手元の PC の serve は信頼するので、いつも名乗る。from がつながっていない・pane が無い（古い serve）ときも名乗らない。
 */
export function callerOrigin(
  serverIds: Record<string, string | undefined>,
  from: string,
  pane: string | undefined,
): PaneOrigin | undefined {
  const server = serverIds[from];
  if (!server || !pane) return undefined;
  for (const [target, id] of Object.entries(serverIds))
    if (from !== LOCAL && target !== from && id === server) return undefined;
  return { server, pane };
}

/** list の答えの 1 行から、id・名前・作った側（手元の PC のペインの id）を読む。形が違えば undefined。 */
function paneOf(
  x: unknown,
): { id: string; name?: string; openedFrom: string[] } | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const { id, name, openedFrom } = x as Record<string, unknown>;
  if (typeof id !== "string") return undefined;
  return {
    id,
    ...(typeof name === "string" && name !== "" ? { name } : {}),
    openedFrom: Array.isArray(openedFrom)
      ? openedFrom.filter((p): p is string => typeof p === "string")
      : [],
  };
}

/** pane.relay を受けて、頼みをそのマシンで行う関数を作る。 */
export function createPaneRelay(deps: {
  sessions: Pick<Sessions, "sessions" | "states" | "machines" | "labelOf">;
  /** マシン target に、ワークスペースのターミナルのタブを開く（`kisui pane open`。投げずに、開けなければ理由を返す） */
  openTab(target: string, rq: PaneOpenRequest): Promise<PaneOpenReport>;
  /** ssh 先のマシンから手元の PC への頼みを通すかを決めるもの。無ければ、手元の PC へは中継しない */
  local?: LocalGate;
  /** 人に聞かない頼みで、相手のマシンの答えを待つ時間（ミリ秒。テストで短くする） */
  waitMs?: number;
}) {
  const { sessions, states, machines, labelOf } = deps.sessions;
  const waitMs = deps.waitMs ?? RELAY_WAIT_MS;

  /** p を waitMs まで待つ。過ぎたら、マシン machine が答えなかったという理由で断る（頼みは、そのマシンで行われるかもしれない）。 */
  function within<R extends object>(
    p: Promise<R>,
    machine: string,
  ): Promise<R | { error: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: T("paneRelay.err.timeout", { machine }) }),
        waitMs,
      );
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }

  /**
   * マシン from（pane.relay を送ってきた serve のマシン）の頼み rq を、マシン machine で行い、答えを返す
   * （投げない。できなければ error に理由）。by は、待ちの id（取り下げで使う）・頼んだペインの id・作るタブに持たせる系譜。
   */
  return async function relay(
    from: string,
    machine: string,
    rq: PaneRunRequest,
    by: { id?: string; pane?: string; ancestry?: PaneOrigin[] } = {},
  ): Promise<PaneRunReply> {
    const list = untrack(machines);
    const name = machine.trim();
    const target = machineTarget(list, name);
    const gate = deps.local;
    const toLocal = from !== LOCAL && target === LOCAL;
    if (toLocal && !gate?.granted(from))
      return {
        error: T("paneRelay.err.localNotGranted", { from: labelOf(from) }),
      };
    // ssh 先のマシンには、許していない先のことを何も教えない（その名前のマシンがあるかも、マシンの名前の一覧も）
    if (
      from !== LOCAL &&
      (target === undefined || !paneRelayAllowed(list, from, target, toLocal))
    )
      return {
        error: T("paneRelay.err.notAllowed", {
          from: labelOf(from),
          machine: name,
        }),
      };
    if (target === undefined)
      return {
        error: T("paneRelay.err.noMachine", {
          machine: name,
          machines: machineNames(list).join(", "),
        }),
      };
    const all = untrack(sessions);
    const caller = callerOrigin(
      Object.fromEntries(
        Object.entries(all).map(([t, x]) => [t, x.connectedServerId]),
      ),
      from,
      by.pane,
    );
    const s = all[target];
    const up = (t: string) => untrack(states)[t]?.kind === "connected";
    let run = rq;
    let askEach = false;
    if (toLocal && gate) {
      // 人に聞くので、頼んだ serve が答えを長く待てること（pane.relay.wait）と、頼んだペインを名乗れることが要る
      const server = all[LOCAL]?.connectedServerId;
      if (!caller || !server || !all[from]?.canWaitRelay)
        return {
          error: T("err.session.tooOld", { machine: labelOf(from) }),
        };
      if (rq.cmd === "open-tab") {
        const d = await gate.askOpen({
          kind: "open",
          id: by.id ?? "",
          from,
          workspace: rq.workspace ?? "",
          isNew: rq.new === true,
          name: rq.name ?? "",
          cwd: rq.cwd ?? "",
          argv: rq.argv ?? [],
        });
        // 聞いている間に許可が終わった・頼んだマシンが切れたら、答えによらず断る
        if (d === "deny" || !gate.granted(from) || !up(from))
          return { error: T("paneRelay.err.refused") };
        askEach = d === "allow-ask";
      } else if (rq.cmd !== "list" && gate.anyAskEach()) {
        // 相手のペインを id で引き、「毎回聞く」ペイン（か、そこから作られたペイン）なら聞く。あとは id で指す
        // （聞いたペインと、操作するペインが食い違わないように）
        if (!s || !up(target))
          return {
            error: T("err.session.notConnected", { machine: labelOf(target) }),
          };
        const listed = await within(
          s.runPane({ cmd: "list" }, caller).catch(
            (e: unknown): PaneRunReply => ({
              error: e instanceof Error ? e.message : String(e),
            }),
          ),
          labelOf(target),
        );
        if (listed.error !== undefined) return { error: listed.error };
        const pane = (("panes" in listed ? listed.panes : undefined) ?? [])
          .map(paneOf)
          .find((p) => p && (p.name === rq.to || p.id === rq.to));
        if (pane && gate.mustAskEach(server, pane.id, pane.openedFrom)) {
          const ok = await gate.askOp({
            kind: "op",
            id: by.id ?? "",
            from,
            cmd: rq.cmd as "send" | "keys" | "read" | "close",
            pane: pane.name ?? pane.id,
            ...(rq.text !== undefined ? { text: rq.text } : {}),
            ...(rq.keys !== undefined ? { keys: rq.keys } : {}),
          });
          if (!ok || !gate.granted(from) || !up(from))
            return { error: T("paneRelay.err.refused") };
          run = { ...rq, to: pane.id };
        }
      }
    }
    if (rq.cmd === "open-tab") {
      const r = await within(
        deps.openTab(target, {
          id: "",
          workspace: rq.workspace ?? "",
          name: rq.name ?? "",
          // 無ければそのマシンの始めのフォルダ（workspace.create の dir 無し）
          dir: rq.cwd ?? "",
          ...(rq.new === true ? { new: true } : {}),
          ...(rq.argv?.length ? { argv: rq.argv } : {}),
          // 名乗れない送り元（callerOrigin）の作ったタブには、系譜を持たせない（どのペインからも届かない）
          ...(caller && by.ancestry?.length ? { ancestry: by.ancestry } : {}),
        }),
        labelOf(target),
      );
      if ("error" in r) return { error: r.error };
      if (askEach) {
        const server = all[LOCAL]?.connectedServerId;
        if (server) gate?.markAskEach(server, r.termId);
      }
      return { ok: true, id: r.termId };
    }
    if (!s || !up(target))
      return {
        error: T("err.session.notConnected", { machine: labelOf(target) }),
      };
    return within(
      s.runPane(run, caller).catch(
        (e: unknown): PaneRunReply => ({
          error: e instanceof Error ? e.message : String(e),
        }),
      ),
      labelOf(target),
    );
  };
}
