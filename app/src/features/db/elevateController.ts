// DB の権限を、時間を決めて一時的に強める（#383）の操作：強める窓を出す（DB のタブの窓の `p`）・強める・時間の前に戻す（`P`）・
// 強めていることと残りの時間を DB のタブに出す。強めた状態を持つのは kisui serve（メモリだけ。止まる・引き継がれると元に戻る）で、
// 窓は db.connections の答えから「誰の権限を、あと何秒強めているか」を覚え、時計で残りを数える。画面にも Tauri にも触らない。
import { T } from "../../i18n/index.ts";
import { createSignal, untrack } from "solid-js";

import type { DbConnection } from "../../infrastructure/rpc/protocol.ts";
import type { Session } from "../sessions/session.ts";
import { dbRefLabel, dbRefParams, type DbRef } from "../workspaces/model.ts";
import {
  ACTORS,
  actorText,
  durationText,
  elevateFailure,
  elevateRows,
  elevationsOf,
  elevationTexts,
  type DbActor,
  type ElevateRow,
  type Elevation,
} from "./elevate.ts";
import { connectionOf } from "./model.ts";

/** 強める窓に出すもの。rows は聞き終えるまで無い。 */
export interface DbElevateAsk {
  /** 強める接続の DB のタブ */
  tab: string;
  /** 接続の名前（環境の変種があれば `接続 (変種)`） */
  connection: string;
  /** 強められる権限（人・エージェントの順） */
  rows?: ElevateRow[];
  /** 強められなかった理由（窓は開いたまま、時間を直せる） */
  error?: string;
}

/** 接続 1 つ（マシン・接続・変種）の名前。強めた状態は、DB のタブごとではなく接続ごと。 */
type ConnKey = string;
const keyOf = (ref: Pick<DbRef, "target" | "connection" | "variant">) =>
  JSON.stringify([ref.target, ref.connection, ref.variant ?? ""]);

interface Held {
  ref: Pick<DbRef, "target" | "connection" | "variant">;
  list: Elevation[];
}

/** 強める操作の持ち物を作る。 */
export function createDbElevate(deps: {
  refOf: (id: string) => DbRef | undefined;
  /** ref のマシンの、DB を扱える接続（つながっていない・古い kisui serve なら、理由を投げる） */
  sessionFor: (ref: Pick<DbRef, "target">) => Session;
  /** ref のマシンの kisui serve が、権限を強める要求（db-elevate）を受けるか。unknown：つながっていない */
  supported: (ref: Pick<DbRef, "target">) => "yes" | "no" | "unknown";
  /** 少しの間だけ出る短い知らせ */
  showToast: (text: string) => void;
  /** できなかったことを伝える（題と理由） */
  fail: (title: string, text: string) => void;
  /** 今使っているペイン（DB のタブを出していれば SQL の入力欄）にキーを向ける */
  focusTerminal: () => void;
  /** 今の時刻（ミリ秒。テストで決める） */
  now?: () => number;
  /** 残りの時間を数える時計（テストで止める）。tick を 1 秒ごとに呼び、止める関数を返す */
  startClock?: (tick: () => void) => () => void;
}) {
  const clockNow = deps.now ?? (() => Date.now());
  const startClock =
    deps.startClock ??
    ((tick: () => void) => {
      const t = setInterval(tick, 1000);
      return () => clearInterval(t);
    });

  /** 今強めている権限（接続ごと）。強めていない接続は入らない。 */
  const [held, setHeld] = createSignal<Readonly<Record<ConnKey, Held>>>({});
  /** 残りの時間を出すための時刻（時計が動いている間、1 秒ごとに進む）。 */
  const [now, setNow] = createSignal(clockNow());
  let stopClock: (() => void) | undefined;

  /** 強めているものがある間だけ、時計を動かす。 */
  function syncClock() {
    const any = Object.keys(untrack(held)).length > 0;
    if (any && !stopClock) {
      setNow(clockNow());
      stopClock = startClock(tick);
    } else if (!any && stopClock) {
      stopClock();
      stopClock = undefined;
    }
  }

  /** 時計の 1 回：時間の過ぎたものを外し、その接続を kisui serve に聞き直す（本当に戻ったかは kisui serve が決める）。 */
  function tick() {
    const t = clockNow();
    setNow(t);
    const expired = Object.values(untrack(held)).filter((h) =>
      h.list.some((e) => e.deadline <= t),
    );
    if (expired.length === 0) return;
    for (const h of expired) {
      put(
        h.ref,
        h.list.filter((e) => e.deadline > t),
      );
      void refresh(h.ref);
    }
  }

  function put(ref: Held["ref"], list: Elevation[]) {
    const key = keyOf(ref);
    setHeld((all) => {
      const { [key]: _, ...rest } = all;
      return list.length > 0
        ? {
            ...rest,
            [key]: {
              ref: {
                target: ref.target,
                connection: ref.connection,
                ...(ref.variant ? { variant: ref.variant } : {}),
              },
              list,
            },
          }
        : rest;
    });
    syncClock();
  }

  /** kisui serve が答えた接続 c から、強めている権限を覚え直す。 */
  function note(ref: Held["ref"], c: DbConnection | undefined) {
    put(ref, c ? elevationsOf(c, clockNow()) : []);
  }

  /** ref の接続を kisui serve に聞く（設定に無ければ undefined）。聞けなければ投げる。 */
  async function ask(ref: Held["ref"]): Promise<DbConnection | undefined> {
    const { connections } = await deps
      .sessionFor(ref)
      .request("db.connections", {});
    return connectionOf(connections, ref);
  }

  /**
   * ref の接続の強めている権限を、kisui serve に聞き直す（DB のタブを出したとき・つなぎ直したとき・時間が過ぎたとき）。
   * 聞けなければ（つながっていない・古い kisui serve）、強めていないことにする：kisui serve が替わったなら、強めた状態はもう無い。
   */
  async function refresh(ref: Held["ref"]): Promise<void> {
    if (deps.supported(ref) !== "yes") {
      note(ref, undefined);
      return;
    }
    try {
      note(ref, await ask(ref));
    } catch {
      note(ref, undefined);
    }
  }

  /** タブ id の接続で今強めている権限の字（見出しに出す。強めていなければ空）。残りの時間は 1 秒ごとに変わる。 */
  function elevatedOf(id: string): string[] {
    const ref = deps.refOf(id);
    const h = ref && held()[keyOf(ref)];
    return h ? elevationTexts(h.list, now()) : [];
  }

  // ---- 強める窓 ----
  const [elevateAsk, setElevateAsk] = createSignal<DbElevateAsk | null>(null);
  let gen = 0;

  /** 古い kisui serve（権限を強める要求を知らない）なら、理由を伝えて true。 */
  function oldServe(ref: DbRef): boolean {
    if (deps.supported(ref) !== "no") return false;
    deps.fail(T("cannot.dbElevate.title"), T("cannot.dbElevate.old"));
    return true;
  }

  /**
   * タブ id の接続の権限を強める窓を出す。その接続の強められる権限を kisui serve に聞き、1 つも無ければ窓を出さずに理由を伝える。
   */
  async function openElevate(id: string): Promise<void> {
    const ref = deps.refOf(id);
    if (!ref || oldServe(ref)) return;
    const mine = ++gen;
    const connection = dbRefLabel(ref);
    setElevateAsk({ tab: id, connection });
    let c: DbConnection | undefined;
    try {
      c = await ask(ref);
    } catch (e) {
      if (mine !== gen) return;
      setElevateAsk(null);
      deps.fail(T("cannot.dbElevate.title"), elevateFailure(e));
      return;
    }
    if (mine !== gen) return;
    note(ref, c);
    const rows = c ? elevateRows(c) : [];
    if (rows.length === 0) {
      setElevateAsk(null);
      deps.fail(
        T("cannot.dbElevate.title"),
        c ? T("cannot.dbElevate.none") : T("db.err.noConnection"),
      );
      return;
    }
    setElevateAsk({ tab: id, connection, rows });
  }

  /** 窓をやめる（キーを今のペインに戻す）。 */
  function closeElevate() {
    gen++;
    setElevateAsk(null);
    deps.focusTerminal();
  }

  /**
   * 窓で決めた：actor の権限を、duration（打たれた字のまま。読むのは kisui serve）の間だけ強める。強められたら窓を閉じて知らせ、
   * 断られたら（上限を超える・書き方が違う）理由を窓に出して、開いたままにする。
   */
  async function submitElevate(actor: DbActor, duration: string) {
    const a = untrack(elevateAsk);
    const ref = a && deps.refOf(a.tab);
    if (!a || !ref) return;
    const mine = ++gen;
    try {
      const { connection } = await deps.sessionFor(ref).request("db.elevate", {
        ...dbRefParams(ref),
        actor,
        duration: duration.trim(),
      });
      note(ref, connection);
      const on = connection[actor];
      deps.showToast(
        T("db.elevate.done", {
          who: actorText(actor),
          permission: on?.permission ?? "",
          time: durationText(on?.elevated?.remainingSeconds ?? 0),
        }),
      );
      if (mine !== gen) return;
      setElevateAsk(null);
      deps.focusTerminal();
    } catch (e) {
      if (mine !== gen) return;
      setElevateAsk({ ...a, error: elevateFailure(e) });
    }
  }

  /**
   * タブ id の接続の、強めている権限を全部、時間の前に元に戻す（人のものもエージェントのものも。戻すのは弱める向きなので、聞かない）。
   * 強めているものが無ければ、その旨を伝える。
   */
  async function endElevation(id: string): Promise<void> {
    const ref = deps.refOf(id);
    if (!ref || oldServe(ref)) return;
    try {
      let c = await ask(ref);
      const actors = ACTORS.filter((actor) => c?.[actor]?.elevated);
      if (actors.length === 0) {
        note(ref, c);
        deps.fail(
          T("cannot.dbElevateEnd.title"),
          T("cannot.dbElevateEnd.none"),
        );
        return;
      }
      const session = deps.sessionFor(ref);
      for (const actor of actors)
        c = (
          await session.request("db.elevateEnd", {
            ...dbRefParams(ref),
            actor,
          })
        ).connection;
      note(ref, c);
      deps.showToast(
        T("db.elevate.ended", {
          who: actors.map(actorText).join(T("db.elevate.and")),
        }),
      );
    } catch (e) {
      deps.fail(T("cannot.dbElevateEnd.title"), elevateFailure(e));
      void refresh(ref);
    }
  }

  /**
   * alive が false を返す接続（DB のタブが 1 つも残っていない）の強めた状態を忘れる（窓が覚えている分だけ。kisui serve の
   * 強めた状態は変えない）。次にその接続の DB のタブを出したときに、聞き直す。閉じたタブの強める窓も閉じる。
   */
  function forgetElevations(alive: (ref: Held["ref"]) => boolean) {
    for (const h of Object.values(untrack(held)))
      if (!alive(h.ref)) put(h.ref, []);
    const a = untrack(elevateAsk);
    if (a && !deps.refOf(a.tab)) {
      gen++;
      setElevateAsk(null);
    }
  }

  return {
    elevatedOf,
    refreshElevation: refresh,
    forgetElevations,
    elevateAsk,
    openElevate,
    closeElevate,
    submitElevate,
    endElevation,
  };
}
