// DB のタブで打って通ったパスワードを、窓を閉じるまで覚える（メモリだけ。localStorage などには書かない）。
// 画面にも Solid にも Tauri にも依存しない（node --test で確かめられる）。
//
// なぜ窓が覚えるか：kisui serve は、窓で打って覚えたパスワードを、その窓の接続が切れたとき・別の窓が持ち主になったときに
// 全部忘れる（server/db.go）。窓が覚えていれば、つなぎ直したあとに db.remember で渡し直せるので、人が打ち直さなくても、
// 窓の要求も、コーディングエージェントの kisui db のコマンドも続けられる。
//
// 覚えたパスワードは、接続の名前だけでなく、打ったときの行き先（種類・ホスト・ポート・ユーザー）と一緒に持つ。渡し直すときは
// 行き先も送り、kisui serve が今の設定と比べる。違えば覚えず、窓も捨てる：設定を書き換えたあとに、前の行き先のパスワードを
// 別のサーバーに送らない。印 db-remember の無い古い kisui serve には、覚えも渡し直しもしない（controller.ts）。

import {
  hasCapability,
  type DbConnection,
  type HelloResult,
  type Requests,
} from "../../infrastructure/rpc/protocol.ts";

/** db.remember を受ける kisui serve の印（capabilities）。 */
export const DB_REMEMBER_CAPABILITY = "db-remember";

/**
 * 覚えたパスワードが誰のものか：マシンと、kisui serve が覚えたパスワードを見分ける組（internal/db の identity）。
 * どれか 1 つでも違えば、別のもの。
 */
export interface PasswordOwner {
  /** 接続を書いたマシン（ssh の行き先か `@local`） */
  target: string;
  /** 接続の名前 */
  connection: string;
  /** 環境の変種の名前。変種の無い接続は "" */
  variant: string;
  kind: DbConnection["kind"];
  host: string;
  port: number;
  user: string;
}

/** 覚えたパスワード 1 つ。 */
export interface RememberedPassword {
  owner: PasswordOwner;
  password: string;
}

/** マシン target の接続 c（db.connections の 1 つ）で打つパスワードの持ち主。 */
export function passwordOwner(target: string, c: DbConnection): PasswordOwner {
  return {
    target,
    connection: c.name,
    variant: c.variant ?? "",
    kind: c.kind,
    host: c.host,
    port: c.port,
    user: c.user,
  };
}

/** DB のタブが指す接続（マシン・接続の名前・変種）。 */
export interface PasswordPlace {
  target: string;
  connection: string;
  variant?: string;
}

const placeKey = (p: PasswordPlace) =>
  JSON.stringify([p.target, p.connection, p.variant ?? ""]);

/**
 * 覚えたパスワードの置き場。窓の 1 回の起動の間だけ、メモリに持つ（どこにも書かない）。
 * 1 つの接続（マシン・名前・変種）に覚えるのは 1 つ：行き先の違うものを覚えたら、前のものは捨てる。
 */
export class PasswordMemory {
  private readonly kept = new Map<string, RememberedPassword>();

  /** owner で打って通ったパスワードを覚える（同じ接続の前のものは置き換える）。 */
  remember(owner: PasswordOwner, password: string): void {
    this.kept.set(placeKey(owner), { owner, password });
  }

  /** 接続 place に覚えているもの（無ければ undefined）。 */
  find(place: PasswordPlace): RememberedPassword | undefined {
    return this.kept.get(placeKey(place));
  }

  /** 接続 place に覚えているものを捨てる。 */
  forget(place: PasswordPlace): void {
    this.kept.delete(placeKey(place));
  }

  /** e を捨てる。その接続に、もう別のものを覚えていれば（打ち直した）、何もしない。 */
  drop(e: RememberedPassword): void {
    if (this.kept.get(placeKey(e.owner)) === e)
      this.kept.delete(placeKey(e.owner));
  }

  /** マシン target に覚えているもの全部。 */
  of(target: string): RememberedPassword[] {
    return [...this.kept.values()].filter((e) => e.owner.target === target);
  }
}

/** db.remember を送る（params を、そのマシンの kisui serve に）。 */
export type SendRemember = (
  params: Requests["db.remember"]["params"],
) => Promise<Requests["db.remember"]["result"]>;

/** e を渡し直す db.remember の引数：パスワードと、それを打ったときの行き先。 */
export function rememberParams(
  e: RememberedPassword,
): Requests["db.remember"]["params"] {
  const o = e.owner;
  return {
    connection: o.connection,
    ...(o.variant ? { variant: o.variant } : {}),
    kind: o.kind,
    host: o.host,
    port: o.port,
    user: o.user,
    password: e.password,
  };
}

/**
 * 覚えているパスワード e を、kisui serve に渡し直す。kisui serve が覚えたら true。
 * kisui serve が覚えなかった（接続が設定から消えた・行き先が変わった）ら、e を捨てて false：そのパスワードは、もう使わない。
 * 送れなかった（切れた など）ら、捨てずに false（次につなぎ直したときに、また渡す）。
 */
export async function handBack(
  memory: PasswordMemory,
  e: RememberedPassword,
  send: SendRemember,
): Promise<boolean> {
  try {
    const { remembered } = await send(rememberParams(e));
    if (!remembered) memory.drop(e);
    return remembered === true;
  } catch {
    return false;
  }
}

/** マシン target に覚えているパスワードを、全部渡し直す（つなぎ直した直後）。 */
export async function handBackAll(
  memory: PasswordMemory,
  target: string,
  send: SendRemember,
): Promise<void> {
  await Promise.all(memory.of(target).map((e) => handBack(memory, e, send)));
}

/**
 * 新しくつながった（session.hello が通った）マシンのうち、db.remember を受けるもの。つなぎ直しも、新しくつながったと数える
 * （hello の返事は、つなぐたびに別のもの）。seen は、前に見たときの、マシンごとの hello の返事で、今の様子に書き換える。
 */
export function newlyConnected(
  seen: Map<string, HelloResult>,
  states: Readonly<Record<string, { kind: string; hello?: HelloResult }>>,
): string[] {
  const out: string[] = [];
  for (const target of [...seen.keys()])
    if (states[target]?.kind !== "connected") seen.delete(target);
  for (const [target, st] of Object.entries(states)) {
    if (st.kind !== "connected" || !st.hello) continue;
    if (seen.get(target) === st.hello) continue;
    seen.set(target, st.hello);
    if (hasCapability(st.hello, DB_REMEMBER_CAPABILITY)) out.push(target);
  }
  return out;
}

/**
 * 1 つの接続の要求（model.ts の withPassword）に渡す、覚えたパスワードの扱い。
 * 覚えない相手（印 db-remember の無い古い kisui serve）の要求には渡さない。
 */
export interface PasswordKeeper {
  /**
   * kisui serve が「窓で打ったパスワードを持っていない」と断ったときに呼ぶ：その接続に覚えているものを渡し直す。
   * 渡せたら true（呼ぶ側は、パスワードを付けずに送り直す）。覚えていない・渡せなかったら false（利用者に聞く）。
   */
  handBack: () => Promise<boolean>;
  /** 覚えていたパスワードを DB が断ったときに呼ぶ：その接続に覚えているものを捨てる。 */
  forget: () => void;
  /**
   * 利用者が打ったパスワードを送る前に呼ぶ。返す関数は、そのパスワードでログインが通ったら呼ぶ（覚える）。
   * 行き先は、送る前に確かめる：利用者が打ったのは、その行き先のパスワード。
   */
  typed: (password: string) => Promise<() => void>;
}

/**
 * 接続 place の PasswordKeeper を作る。owner は、その接続の今の行き先を聞く（db.connections。聞けない・一覧に無ければ
 * undefined で、そのときは覚えない）。send は db.remember を送る。
 */
export function passwordKeeper(
  memory: PasswordMemory,
  place: PasswordPlace,
  io: { owner: () => Promise<PasswordOwner | undefined>; send: SendRemember },
): PasswordKeeper {
  return {
    handBack: async () => {
      const e = memory.find(place);
      return e !== undefined && handBack(memory, e, io.send);
    },
    forget: () => memory.forget(place),
    typed: async (password) => {
      let owner: PasswordOwner | undefined;
      try {
        owner = await io.owner();
      } catch {
        owner = undefined;
      }
      return () => {
        if (owner) memory.remember(owner, password);
        // 行き先が分からないまま通った：前に覚えたものは、今の行き先のものか分からないので捨てる
        else memory.forget(place);
      };
    },
  };
}
