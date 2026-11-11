// コマンドの表（docs/key-design.md の 2 章の方針 7）。リーダー（Mac は Cmd+K、Linux は Ctrl+Shift+K）の木と、リーダーを通さず
// 1 回で押せる近道を、ここ 1 か所に書く。リーダーを押すと出る案内（LeaderMenu.tsx）、`?` の一覧（KeyListDialog.tsx）、
// 実際にキーを受ける判定（route）は、どれもこの表から作る。だから案内と受けるキーはずれない。
//
// キーを足す・変えるときは LEADER を直す（足すだけなら、グループの children に leaf() を 1 つ足す）。
// 動きの中身は App.tsx の runCommand が id で受ける。docs/key-design.md の表も一緒に直す。
// DOM には触らない（node --test で確かめられる）。

import type { KeyLike } from "./guiKeys.ts";
import { isKey, isModifierOnly, matchSpec, parseSpec } from "./keyspec.ts";

/** コマンドの名前。動きは App.tsx の runCommand が持つ。 */
export type CommandId =
  | "pane.focus"
  | "pane.last"
  | "pane.split"
  | "pane.close"
  | "pane.zoom"
  | "pane.resize"
  | "workspace.nth"
  | "workspace.last"
  | "workspace.new"
  | "workspace.close"
  | "machine.add"
  | "machine.rename"
  | "machine.remove"
  | "machine.disconnect"
  | "machine.reconnect"
  | "clipboard.history"
  | "scale"
  | "notice.act"
  | "notice.dismiss"
  | "notice.focusNotified"
  | "help.keys";

/** コマンドと、その引数（向き・番号など）。 */
export interface Command {
  id: CommandId;
  arg?: string | number;
}

/** 近道。OS ごとに 1 つ（無ければその OS には近道が無い）。書き方は keyspec.ts の parseSpec。 */
export interface Shortcut {
  mac?: string;
  other?: string;
}

interface Common {
  label: string;
  shortcut?: Shortcut;
}

/** リーダーの下の、動きを行う 1 つ。 */
export interface Leaf extends Common {
  type: "leaf";
  /** 押すキー（どれでも同じ。`+` と `=` のように並べる） */
  keys: string[];
  run: Command;
  /** 行ったあともリーダーを出ず、同じ一覧のまま次のキーを待つ（ペインを `j` `j` `l` と続けて移れる） */
  repeat?: boolean;
  /** 近道は、キーがペインに向いているときか、どこにも向いていないときだけ受ける（Cmd+W が、窓を閉じるのを防ぐため） */
  shortcutInPane?: boolean;
}

/** 一段下の一覧に入る 1 つ。shortcut は、そのグループに 1 回で入る近道。 */
export interface Group extends Common {
  type: "group";
  key: string;
  children: Node[];
}

export type Node = Leaf | Group;

function leaf(
  keys: string | string[],
  label: string,
  run: Command,
  opts: Pick<Leaf, "repeat" | "shortcut" | "shortcutInPane"> = {},
): Leaf {
  return {
    type: "leaf",
    keys: typeof keys === "string" ? [keys] : keys,
    label,
    run,
    ...opts,
  };
}

function group(
  key: string,
  label: string,
  children: Node[],
  shortcut?: Shortcut,
): Group {
  return { type: "group", key, label, children, shortcut };
}

/** リーダーに入るキー。Linux で Super を使わないのは、Windows（Win+K）や i3・sway で取られるため。Shift なしの Ctrl+K は shj に届く。 */
export const LEADER_SHORTCUT: Shortcut = {
  mac: "Cmd+K",
  other: "Ctrl+Shift+K",
};

/** 向きの葉。1 段目と、ペインのグループ（入口の近道から入ったとき）の両方に置く。 */
const paneMoves = (): Leaf[] =>
  (
    [
      ["h", "左", "left"],
      ["j", "下", "down"],
      ["k", "上", "up"],
      ["l", "右", "right"],
    ] as const
  ).map(([k, name, dir]) =>
    leaf(
      k,
      `${name}のペインへフォーカスを移す`,
      { id: "pane.focus", arg: dir },
      { repeat: true },
    ),
  );

/**
 * リーダーの木。1 段目から下へ。
 * ワークスペースのグループ（w）の `h` `j` `k` `l`（ワークスペースとマシンを移る）と、画像のペインの拡大・縮小、URL のヒントモードは、
 * それぞれの Issue（#88・#93・#51）が、ここに葉を足して入れる。足すまでは、案内にも出ない。
 */
export const LEADER: Node[] = [
  ...paneMoves(),
  leaf(
    "Tab",
    "直前にフォーカスがあったペインへ戻る",
    { id: "pane.last" },
    {
      repeat: true,
    },
  ),
  group(
    "w",
    "ワークスペース",
    [
      leaf("Tab", "直前に選んでいたワークスペースへ戻る", {
        id: "workspace.last",
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        leaf(
          String(i + 1),
          `サイドバーの上から ${i + 1} 番目のワークスペースへ`,
          { id: "workspace.nth", arg: i },
          { shortcut: { mac: `Cmd+${i + 1}` } },
        ),
      ),
      leaf("n", "今のマシンにワークスペースを作る", { id: "workspace.new" }),
      leaf("x", "今のワークスペースを閉じる（確認が出ることがある）", {
        id: "workspace.close",
      }),
    ],
    { mac: "Cmd+Shift+W", other: "Ctrl+Shift+W" },
  ),
  group("m", "マシン", [
    leaf("a", "マシンを足す", { id: "machine.add" }),
    leaf("n", "今のマシンの名前を変える", { id: "machine.rename" }),
    leaf("d", "今のマシンを一覧から外す", { id: "machine.remove" }),
    leaf("x", "今のマシンへのつなぎを切る", { id: "machine.disconnect" }),
    leaf("r", "今のマシンにつなぎ直す", { id: "machine.reconnect" }),
  ]),
  group(
    "p",
    "ペイン",
    [
      ...paneMoves(),
      leaf(
        "v",
        "今のペインを右に分ける",
        { id: "pane.split", arg: "right" },
        { shortcut: { mac: "Cmd+D", other: "Ctrl+Shift+D" } },
      ),
      leaf(
        "s",
        "今のペインを下に分ける",
        { id: "pane.split", arg: "down" },
        { shortcut: { mac: "Cmd+Shift+D", other: "Ctrl+Shift+E" } },
      ),
      leaf(
        "x",
        "今のペインを閉じる（プライマリのペインは閉じない）",
        { id: "pane.close" },
        { shortcut: { mac: "Cmd+W" }, shortcutInPane: true },
      ),
      leaf(
        "z",
        "プライマリのペイン以外を隠す・戻す",
        { id: "pane.zoom" },
        { shortcut: { mac: "Cmd+Shift+Enter", other: "Ctrl+Shift+M" } },
      ),
      leaf(
        "r",
        "リサイズモードに入る（境界を h j k l で動かす）",
        { id: "pane.resize" },
        { shortcut: { mac: "Cmd+R", other: "Ctrl+Shift+R" } },
      ),
    ],
    { mac: "Cmd+Shift+P", other: "Ctrl+Shift+P" },
  ),
  leaf(
    "y",
    "クリップボードの履歴を開く",
    { id: "clipboard.history" },
    { shortcut: { mac: "Cmd+Shift+H", other: "Ctrl+Shift+H" } },
  ),
  group("v", "表示の大きさ", [
    leaf(
      ["+", "="],
      "表示を大きくする",
      { id: "scale", arg: "in" },
      { repeat: true, shortcut: { mac: "Cmd+=", other: "Ctrl+=" } },
    ),
    // Linux の Ctrl+- は端末の C-_（shj のコメントの切り替え、シェルの undo）と同じ符号なので、近道にしない
    leaf(
      "-",
      "表示を小さくする",
      { id: "scale", arg: "out" },
      { repeat: true, shortcut: { mac: "Cmd+-" } },
    ),
    leaf(
      "0",
      "表示を元の大きさに戻す",
      { id: "scale", arg: "reset" },
      { shortcut: { mac: "Cmd+0", other: "Ctrl+0" } },
    ),
  ]),
  group("n", "お知らせ", [
    leaf("a", "いちばん下のお知らせの、主のボタンを押す", {
      id: "notice.act",
    }),
    leaf("d", "いちばん下のお知らせを閉じる", { id: "notice.dismiss" }),
    leaf("g", "最後に OS の通知を出したペインを前に出す", {
      id: "notice.focusNotified",
    }),
  ]),
  leaf("?", "全部のキーの一覧を出す", { id: "help.keys" }),
];

/** リーダーの木の中の位置（リーダーを押してから押したキー）。[] はリーダーを押した直後の 1 段目。 */
export type Path = readonly string[];

/** path の一覧（そのグループの children）。path が葉や無い所を指すなら undefined。 */
export function childrenAt(
  path: Path,
  root: Node[] = LEADER,
): Node[] | undefined {
  let list = root;
  for (const k of path) {
    const g = list.find((n): n is Group => n.type === "group" && n.key === k);
    if (!g) return undefined;
    list = g.children;
  }
  return list;
}

/** 一覧の中で、キー e に当たるもの。キーは修飾キー無し（Shift だけは許す）で、字は code でも見る。 */
function nodeFor(list: Node[], e: KeyLike): Node | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  return list.find((n) =>
    n.type === "group"
      ? matchLeaderKey(n.key, e)
      : n.keys.some((k) => matchLeaderKey(k, e)),
  );
}

function matchLeaderKey(k: string, e: KeyLike): boolean {
  // 字は Shift を押していても（Caps Lock でも）当たる。記号は、その記号そのもの（`?` は Shift+/）
  if (/^[a-z]$/.test(k)) return isKey(e, k);
  if (k === "+" || k === "=")
    return e.key === k || (k === "=" && isKey(e, "="));
  if (/^[0-9]$/.test(k)) return !e.shiftKey && isKey(e, k);
  if (k === "Tab" || k === "Escape" || k === "Backspace") return e.key === k;
  return e.key === k;
}

/** 表示用：キーの名前。 */
export function keyName(k: string): string {
  return k;
}

/** 表示用：一覧の 1 行のキー（葉が複数のキーを持つなら「+ =」のように並べる）。 */
export function nodeKeys(n: Node): string {
  return n.type === "group" ? keyName(n.key) : n.keys.map(keyName).join(" ");
}

/** shortcut の、今の OS の書き方。この OS に近道が無ければ undefined。 */
export function shortcutOf(
  s: Shortcut | undefined,
  mac: boolean,
): string | undefined {
  return mac ? s?.mac : s?.other;
}

// ---- 近道（リーダーを通さず 1 回で押せるキー）----

interface ShortcutEntry {
  spec: string;
  /** 葉なら動かすコマンド、グループなら入る先の path */
  command?: Command;
  into?: Path;
  inPane: boolean;
}

function collect(
  list: Node[],
  mac: boolean,
  path: Path,
  out: ShortcutEntry[],
): ShortcutEntry[] {
  for (const n of list) {
    const spec = shortcutOf(n.shortcut, mac);
    if (n.type === "leaf") {
      if (spec) out.push({ spec, command: n.run, inPane: !!n.shortcutInPane });
    } else {
      if (spec) out.push({ spec, into: [...path, n.key], inPane: false });
      collect(n.children, mac, [...path, n.key], out);
    }
  }
  return out;
}

const shortcutCache = new Map<
  boolean,
  { spec: ReturnType<typeof parseSpec>; entry: ShortcutEntry }[]
>();

function shortcuts(mac: boolean) {
  let v = shortcutCache.get(mac);
  if (!v) {
    v = collect(LEADER, mac, [], []).map((entry) => ({
      spec: parseSpec(entry.spec),
      entry,
    }));
    shortcutCache.set(mac, v);
  }
  return v;
}

/** この OS で、リーダーに入るキーか。 */
export function isLeaderKey(e: KeyLike, mac: boolean): boolean {
  const s = shortcutOf(LEADER_SHORTCUT, mac);
  return !!s && matchSpec(e, parseSpec(s));
}

/** e が当たる、リーダーを通さない近道のコマンド。無ければ null。グループの入口の近道は null（route が受ける）。 */
export function shortcutCommand(e: KeyLike, mac: boolean): Command | null {
  for (const { spec, entry } of shortcuts(mac))
    if (entry.command && matchSpec(e, spec)) return entry.command;
  return null;
}

// ---- キーの受け方 ----

/** キーを受ける状態。leader は、リーダーに入っているときの木の中の位置（入っていなければ null）。 */
export interface RouterState {
  leader: Path | null;
  /**
   * リーダーを最後のキーで出た直後。そのキーを押しっぱなしにして出る繰り返し（repeat）を、ターミナルに送らないために捨てる。
   * 次の押し直し（repeat でない keydown）か keyup で解く。
   */
  swallow: boolean;
}

export const IDLE: RouterState = { leader: null, swallow: false };

/** キーを受けるときの周りの様子。 */
export interface Env {
  mac: boolean;
  /** ダイアログが出ている（リーダーに入らない） */
  dialogOpen: boolean;
  /** リサイズモードの中（リーダーに入らない） */
  resizeMode: boolean;
  /** キーがペインに向いているか、どこにも向いていない（shortcutInPane の近道を受ける条件） */
  inPane: boolean;
}

/** route の結果。consume なら、呼んだ側は preventDefault と stopPropagation をして、ターミナルに送らない。 */
export type Routed =
  | { consume: false; state: RouterState }
  | { consume: true; state: RouterState; run?: Command; repeat?: boolean };

/**
 * キー 1 つをどう受けるか。リーダーに入っていないときは、リーダーのキー・近道に当たるものだけを受け、ほかは一切受けない
 * （shj やシェルにそのまま届く）。リーダーに入っている間は、すべてのキーを受ける（一覧に無いキーは捨てて出る）。
 */
export function route(state: RouterState, e: KeyLike, env: Env): Routed {
  if (state.leader) return inLeader(state, state.leader, e, env);

  if (state.swallow) {
    if (e.repeat) return { consume: true, state };
    state = IDLE;
  }
  if (e.isComposing) return { consume: false, state };

  const canEnter = !env.dialogOpen && !env.resizeMode;
  if (isLeaderKey(e, env.mac)) {
    if (!canEnter) return { consume: false, state };
    return e.repeat
      ? { consume: true, state }
      : { consume: true, state: { leader: [], swallow: false } };
  }
  for (const { spec, entry } of shortcuts(env.mac)) {
    if (!matchSpec(e, spec)) continue;
    if (entry.into) {
      if (!canEnter) return { consume: false, state };
      return e.repeat
        ? { consume: true, state }
        : { consume: true, state: { leader: entry.into, swallow: false } };
    }
    if (entry.inPane && !env.inPane) return { consume: false, state };
    return {
      consume: true,
      state,
      run: entry.command,
      repeat: leafRepeat(entry.command),
    };
  }
  return { consume: false, state };
}

/** 近道で動かすコマンドが、押しっぱなしの繰り返しを受けるか（表示の大きさの + と -）。 */
function leafRepeat(c: Command | undefined): boolean {
  return c?.id === "scale" && c.arg !== "reset";
}

function inLeader(
  state: RouterState,
  path: Path,
  e: KeyLike,
  env: Env,
): Routed {
  const stay = { consume: true as const, state };
  const out = {
    consume: true as const,
    state: { leader: null, swallow: true },
  };
  if (isModifierOnly(e)) return stay;
  const list = childrenAt(path) ?? [];
  const node = nodeFor(list, e);
  const leafNode = node?.type === "leaf" ? node : undefined;
  // 押しっぱなしの繰り返しは、続けて押せる葉のほかは捨てる（出ない。入るときのキーの繰り返しで、すぐ出てしまわないように）
  if (e.repeat && !leafNode?.repeat) return stay;
  if (isLeaderKey(e, env.mac) || e.key === "Escape") return out;
  if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey)
    return path.length === 0
      ? out
      : { consume: true, state: { leader: path.slice(0, -1), swallow: false } };
  if (!node) return out;
  if (node.type === "group")
    return {
      consume: true,
      state: { leader: [...path, node.key], swallow: false },
    };
  return {
    consume: true,
    run: node.run,
    repeat: node.repeat,
    state: node.repeat ? state : out.state,
  };
}

/** keyup：押しっぱなしの繰り返しを捨てるのをやめる。 */
export function afterKeyUp(state: RouterState): RouterState {
  return state.swallow ? { ...state, swallow: false } : state;
}

// ---- 全部のキーの一覧（`?`）----

/** 一覧の 1 行。 */
export interface HelpRow {
  /** リーダーを押してから押すキー（"p" "v"） */
  path: string[];
  label: string;
  group: boolean;
  /** この OS の近道（Cmd+D など）。無ければ undefined */
  shortcut?: string;
  depth: number;
}

/** 木を上から順に平らにした一覧。 */
export function helpRows(
  mac: boolean,
  list: Node[] = LEADER,
  path: string[] = [],
): HelpRow[] {
  const out: HelpRow[] = [];
  for (const n of list) {
    const p = [...path, nodeKeys(n)];
    out.push({
      path: p,
      label: n.label,
      group: n.type === "group",
      shortcut: shortcutOf(n.shortcut, mac),
      depth: path.length,
    });
    if (n.type === "group")
      out.push(...helpRows(mac, n.children, [...path, n.key]));
  }
  return out;
}

/** リーダーのキー（この OS の書き方）。 */
export function leaderKeyName(mac: boolean): string {
  return shortcutOf(LEADER_SHORTCUT, mac) ?? "";
}
