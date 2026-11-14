// コマンドの表（docs/key-design.md の 2 章の方針 7）。リーダー（Mac は Cmd+K、Linux は Ctrl+Shift+K）の木と、リーダーを通さず
// 1 回で押せる近道を、ここ 1 か所に書く。リーダーを押すと出る案内（LeaderMenu.tsx）、`?` の一覧（KeyListDialog.tsx）、
// 実際にキーを受ける判定（route）は、どれもこの表から作る。だから案内と受けるキーはずれない。
//
// キーを足す・変えるときは LEADER を直す（足すだけなら、グループの children に leaf() を 1 つ足す）。
// 動きの中身は App.tsx の runCommand が id で受ける。docs/key-design.md の表も一緒に直す。
// DOM には触らない（node --test で確かめられる）。

import type { KeyLike } from "./guiKeys.ts";
import {
  isModifierOnly,
  matchSpec,
  parseSpec,
  type KeySpec,
} from "./keyspec.ts";

/** コマンドの名前。動きは App.tsx の runCommand が持つ。 */
export type CommandId =
  | "pane.focus"
  | "pane.last"
  | "pane.split"
  | "pane.swap"
  | "pane.close"
  | "pane.zoom"
  | "pane.resize"
  | "sidebar.toggle"
  | "workspace.nth"
  | "workspace.step"
  | "workspace.last"
  | "workspace.new"
  | "workspace.close"
  | "workspace.rename"
  | "workspace.move"
  | "machine.dialog"
  | "clipboard.history"
  | "scale"
  | "notice.update"
  | "notice.dismiss"
  | "notice.focusNotified"
  | "browser.new"
  | "browser.url"
  | "browser.back"
  | "browser.forward"
  | "browser.reload"
  | "browser.close"
  | "browser.external"
  | "browser.cycle"
  | "browser.fold"
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
  /** リーダーの案内（LeaderMenu.tsx）に出さない OS。`?` の一覧には、どの OS でも出す */
  hideInMenuOn?: "mac";
}

/** リーダーの下の、動きを行う 1 つ。 */
export interface Leaf extends Common {
  type: "leaf";
  /** 押すキー（どれでも同じ。`+` と `=` のように並べる） */
  keys: string[];
  run: Command;
  /** 行ったあともリーダーを出ず、同じ一覧のまま次のキーを待つ（ペインを `j` `j` `l` と続けて移れる） */
  repeat?: boolean;
  /**
   * 案内では、同じ range.keys が続く葉を 1 行にまとめて出す（`1–9  上から N 番目へ`、`h|j|k|l  ペインを移動`）。`?` の一覧は 1 つずつ出す。
   */
  range?: { keys: string; label: string };
  /** 近道は、キーがペインに向いているときか、どこにも向いていないときだけ受ける（Cmd+W が、窓を閉じるのを防ぐため） */
  shortcutInPane?: boolean;
  /**
   * 近道は、内蔵ブラウザのタブを出しているときだけ受け、そのときは同じキーのほかの近道より先に受ける
   * （Cmd+R / Ctrl+Shift+R は、ブラウザを出している間だけ読み込み直しにし、ほかのときはリサイズモードのまま）
   */
  shortcutInBrowser?: boolean;
}

/** 一段下の一覧に入る 1 つ。shortcut は、そのグループに 1 回で入る近道。 */
export interface Group extends Common {
  type: "group";
  key: string;
  children: Node[];
  /** 設定で有効にしたときだけ出すグループ（内蔵ブラウザ。setBrowserEnabled） */
  feature?: "browser";
}

/** リーダーの木の 1 つ。動きを行う葉か、一段下の一覧に入るグループ。 */
export type Node = Leaf | Group;

function leaf(
  keys: string | string[],
  label: string,
  run: Command,
  opts: Pick<
    Leaf,
    "repeat" | "shortcut" | "shortcutInPane" | "shortcutInBrowser" | "range"
  > = {},
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
  hideInMenuOn?: "mac",
  feature?: "browser",
): Group {
  return {
    type: "group",
    key,
    label,
    children,
    shortcut,
    hideInMenuOn,
    feature,
  };
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
      `${name}のペインへ`,
      { id: "pane.focus", arg: dir },
      { repeat: true, range: { keys: "h|j|k|l", label: "ペインを移動" } },
    ),
  );

/**
 * ワークスペースのグループ（w）の `j` `k`（サイドバーの 1 列で次・前のワークスペースへ）と、
 * `J` `K`（今のワークスペースを 1 つ下・上へ並べ替える）。端では、移るほうは反対の端へ回り、並べ替えるほうは動かさない。続けて押せる。
 * `J` `K` は Shift を押した `j` `k`。小文字の `j` `k` と別の葉にするため、nodeFor が打った字そのもの（大文字）を先に探す。
 */
const workspaceMoves = (): Leaf[] => [
  leaf(
    "j",
    "下のワークスペースへ",
    { id: "workspace.step", arg: "next" },
    { repeat: true, range: { keys: "j|k", label: "ワークスペースを移動" } },
  ),
  leaf(
    "k",
    "上のワークスペースへ",
    { id: "workspace.step", arg: "prev" },
    { repeat: true, range: { keys: "j|k", label: "ワークスペースを移動" } },
  ),
  leaf(
    "J",
    "今のワークスペースを 1 つ下へ動かす",
    { id: "workspace.move", arg: "down" },
    { repeat: true, range: { keys: "J|K", label: "ワークスペースを並べ替え" } },
  ),
  leaf(
    "K",
    "今のワークスペースを 1 つ上へ動かす",
    { id: "workspace.move", arg: "up" },
    { repeat: true, range: { keys: "J|K", label: "ワークスペースを並べ替え" } },
  ),
];

/**
 * リーダーの木。1 段目から下へ。
 * URL のヒントモードに入るキー（#51）は、その Issue が、ここに葉を足して入れる。足すまでは、案内にも出ない。
 * 画像のペインの拡大・縮小（#93）は、リーダーに載せない場所のキー（docs/key-design.md の 5 章。#115 で作る定義）に足す。
 */
export const LEADER: Node[] = [
  ...paneMoves(),
  leaf(
    "Tab",
    "直前のペインへ",
    { id: "pane.last" },
    {
      repeat: true,
    },
  ),
  group(
    "w",
    "ワークスペース",
    [
      ...workspaceMoves(),
      leaf("Tab", "直前のワークスペースへ", {
        id: "workspace.last",
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        leaf(
          String(i + 1),
          `上から ${i + 1} 番目へ`,
          { id: "workspace.nth", arg: i },
          {
            shortcut: { mac: `Cmd+${i + 1}` },
            range: { keys: "1–9", label: "上から N 番目へ" },
          },
        ),
      ),
      leaf("n", "ワークスペースを作る", { id: "workspace.new" }),
      leaf("x", "ワークスペースを閉じる", {
        id: "workspace.close",
      }),
      leaf("r", "名前を変える", {
        id: "workspace.rename",
      }),
    ],
    { mac: "Cmd+Shift+W", other: "Ctrl+Shift+W" },
  ),
  leaf("m", "マシンの一覧を開く", { id: "machine.dialog" }),
  group(
    "p",
    "ペイン",
    [
      ...paneMoves(),
      group("s", "ペインを分ける", [
        leaf(
          "h",
          "左に分ける",
          { id: "pane.split", arg: "left" },
          {
            range: { keys: "h|j|k|l", label: "向きを選んで分ける" },
          },
        ),
        leaf(
          "j",
          "下に分ける",
          { id: "pane.split", arg: "down" },
          {
            shortcut: { mac: "Cmd+Shift+D", other: "Ctrl+Shift+E" },
            range: { keys: "h|j|k|l", label: "向きを選んで分ける" },
          },
        ),
        leaf(
          "k",
          "上に分ける",
          { id: "pane.split", arg: "up" },
          {
            range: { keys: "h|j|k|l", label: "向きを選んで分ける" },
          },
        ),
        leaf(
          "l",
          "右に分ける",
          { id: "pane.split", arg: "right" },
          {
            shortcut: { mac: "Cmd+D", other: "Ctrl+Shift+D" },
            range: { keys: "h|j|k|l", label: "向きを選んで分ける" },
          },
        ),
      ]),
      group(
        "m",
        "隣のペインと入れ替える",
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
            `${name}のペインと入れ替える`,
            { id: "pane.swap", arg: dir },
            { range: { keys: "h|j|k|l", label: "向きを選んで入れ替える" } },
          ),
        ),
      ),
      leaf(
        "x",
        "ペインを閉じる",
        { id: "pane.close" },
        { shortcut: { mac: "Cmd+W" }, shortcutInPane: true },
      ),
      leaf(
        "z",
        "プライマリだけを出す・戻す",
        { id: "pane.zoom" },
        { shortcut: { mac: "Cmd+Shift+Enter", other: "Ctrl+Shift+M" } },
      ),
      leaf(
        "r",
        "リサイズモード",
        { id: "pane.resize" },
        { shortcut: { mac: "Cmd+R", other: "Ctrl+Shift+R" } },
      ),
    ],
    { mac: "Cmd+Shift+P", other: "Ctrl+Shift+P" },
  ),
  // 内蔵ブラウザ（#202）。設定（[gui.browser] enabled）で有効にしたときだけ出す（setBrowserEnabled）
  group(
    "o",
    "ブラウザ",
    [
      leaf("n", "新しいタブを開く", { id: "browser.new" }),
      leaf("u", "URL を書き換える", { id: "browser.url" }),
      leaf(
        "j",
        "次のタブへ",
        { id: "browser.cycle", arg: "next" },
        { repeat: true, range: { keys: "j|k", label: "グリッドとタブを回る" } },
      ),
      leaf(
        "k",
        "前のタブへ",
        { id: "browser.cycle", arg: "prev" },
        { repeat: true, range: { keys: "j|k", label: "グリッドとタブを回る" } },
      ),
      leaf("h", "戻る", { id: "browser.back" }, { repeat: true }),
      leaf("l", "進む", { id: "browser.forward" }, { repeat: true }),
      leaf(
        "r",
        "読み込み直す",
        { id: "browser.reload" },
        {
          shortcut: { mac: "Cmd+R", other: "Ctrl+Shift+R" },
          shortcutInBrowser: true,
        },
      ),
      leaf("x", "タブを閉じる", { id: "browser.close" }),
      leaf("e", "外のブラウザで開く", { id: "browser.external" }),
      leaf("z", "タブの並びを畳む・開く", { id: "browser.fold" }),
    ],
    undefined,
    undefined,
    "browser",
  ),
  leaf("b", "サイドバーを開け閉めする", { id: "sidebar.toggle" }),
  leaf(
    "y",
    "クリップボードの履歴",
    { id: "clipboard.history" },
    { shortcut: { mac: "Cmd+Shift+H", other: "Ctrl+Shift+H" } },
  ),
  // Mac は Cmd+= / Cmd+- / Cmd+0 が共通の操作なので、案内には出さない。Linux は Ctrl+- が端末の Ctrl+_ と同じ信号で近道が無く、
  // `v -` しか小さくするキーが無いので出す。`?` の一覧には、どの OS でも出す
  group(
    "v",
    "表示の大きさ",
    [
      leaf(
        ["+", "="],
        "大きくする",
        { id: "scale", arg: "in" },
        { repeat: true, shortcut: { mac: "Cmd+=", other: "Ctrl+=" } },
      ),
      // Linux の Ctrl+- は端末の C-_（shj のコメントの切り替え、シェルの undo）と同じ符号なので、近道にしない
      leaf(
        "-",
        "小さくする",
        { id: "scale", arg: "out" },
        { repeat: true, shortcut: { mac: "Cmd+-" } },
      ),
      leaf(
        "0",
        "元の大きさに戻す",
        { id: "scale", arg: "reset" },
        { shortcut: { mac: "Cmd+0", other: "Ctrl+0" } },
      ),
    ],
    undefined,
    "mac",
  ),
  group("n", "お知らせ", [
    leaf("u", "新しい版に更新する", { id: "notice.update" }),
    leaf("d", "お知らせを閉じる", { id: "notice.dismiss" }),
    leaf("g", "通知を出したペインへ", {
      id: "notice.focusNotified",
    }),
  ]),
  leaf("?", "キーの一覧", { id: "help.keys" }),
];

/** 内蔵ブラウザ（`o` のグループ）を出すか。設定で有効にしたときだけ App が true にする。 */
let browserEnabled = false;
let activeCache: Node[] | undefined;

/** 内蔵ブラウザのグループ（feature: "browser"）を、リーダーの木・案内・`?` の一覧・近道に入れるか（設定の [gui.browser] enabled）。 */
export function setBrowserEnabled(on: boolean): void {
  if (on === browserEnabled) return;
  browserEnabled = on;
  activeCache = undefined;
  shortcutCache.clear();
}

/** 今使うリーダーの木（設定で有効にしていないグループを除いたもの）。 */
export function activeLeader(): Node[] {
  activeCache ??= LEADER.filter(
    (n) => n.type !== "group" || !n.feature || browserEnabled,
  );
  return activeCache;
}

/** リーダーの木の中の位置（リーダーを押してから押したキー）。[] はリーダーを押した直後の 1 段目。 */
export type Path = readonly string[];

/** path の一覧（そのグループの children）。path が葉や無い所を指すなら undefined。 */
export function childrenAt(
  path: Path,
  root: Node[] = activeLeader(),
): Node[] | undefined {
  let list = root;
  for (const k of path) {
    const g = list.find((n): n is Group => n.type === "group" && n.key === k);
    if (!g) return undefined;
    list = g.children;
  }
  return list;
}

/**
 * 一覧の中で、キー e に当たるもの。キーは修飾キー無し（Shift だけは許す）。
 * 打った字（e.key）で探す。字が分からないとき（かな漢字変換中などで key が Process・Unidentified になる）だけ、
 * 物理キー（e.code）で探す。AZERTY など QWERTY 以外の配列で、別の字の葉に当たらないようにするため。
 */
function nodeFor(list: Node[], e: KeyLike): Node | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const unknown =
    !!e.isComposing || e.key === "Process" || e.key === "Unidentified";
  const find = (by: "key" | "code") =>
    list.find((n) =>
      n.type === "group"
        ? matchLeaderKey(n.key, e, by)
        : n.keys.some((k) => matchLeaderKey(k, e, by)),
    );
  // Shift を押しているときは、大文字の葉（`J` `K`）を先に探す。小文字の葉は Shift を押していても当たるので、後にしないと大文字の葉に届かない
  const upper = e.shiftKey
    ? list.find(
        (n) =>
          n.type === "leaf" &&
          n.keys.some(
            (k) =>
              /^[A-Z]$/.test(k) &&
              (e.key === k || (unknown && e.code === `Key${k}`)),
          ),
      )
    : undefined;
  return upper ?? find("key") ?? (unknown ? find("code") : undefined);
}

function matchLeaderKey(k: string, e: KeyLike, by: "key" | "code"): boolean {
  if (by === "code") {
    const c = e.code ?? "";
    if (/^[a-z]$/.test(k)) return c === `Key${k.toUpperCase()}`;
    if (/^[0-9]$/.test(k))
      return !e.shiftKey && (c === `Digit${k}` || c === `Numpad${k}`);
    if (k === "-") return c === "Minus" || c === "NumpadSubtract";
    if (k === "=" || k === "+") return c === "Equal" || c === "NumpadAdd";
    return false;
  }
  // 字は Shift を押していても（Caps Lock でも）当たる。記号は、その記号そのもの（`?` は Shift+/）
  if (/^[a-z]$/.test(k)) return e.key.toLowerCase() === k;
  if (/^[0-9]$/.test(k)) return !e.shiftKey && e.key === k;
  return e.key === k;
}

/** リーダーの案内の 1 行。 */
export interface MenuRow {
  keys: string;
  label: string;
  group: boolean;
}

/**
 * 案内に出す行。この OS で出さないもの（hideInMenuOn）は除き、range が同じ葉の並びは 1 行にまとめる。
 * `?` の一覧（helpRows）は、これを通さず全部出す。
 */
export function menuRows(path: Path, mac: boolean): MenuRow[] {
  const out: MenuRow[] = [];
  let lastRange: string | undefined;
  for (const n of childrenAt(path) ?? []) {
    if (mac && n.hideInMenuOn === "mac") continue;
    const range = n.type === "leaf" ? n.range : undefined;
    if (range) {
      if (lastRange !== range.keys)
        out.push({ keys: range.keys, label: range.label, group: false });
      lastRange = range.keys;
      continue;
    }
    lastRange = undefined;
    out.push({ keys: nodeKeys(n), label: n.label, group: n.type === "group" });
  }
  return out;
}

/** 表示用：一覧の 1 行のキー（葉が複数のキーを持つなら「+ =」のように並べる）。 */
export function nodeKeys(n: Node): string {
  return n.type === "group" ? n.key : n.keys.join(" ");
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
  /** 内蔵ブラウザのタブを出しているときだけ受ける（葉の shortcutInBrowser） */
  inBrowser: boolean;
  /** 押しっぱなしの繰り返しを受けるか（葉の repeat） */
  repeat: boolean;
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
      if (spec)
        out.push({
          spec,
          command: n.run,
          inPane: !!n.shortcutInPane,
          inBrowser: !!n.shortcutInBrowser,
          repeat: !!n.repeat,
        });
    } else {
      if (spec)
        out.push({
          spec,
          into: [...path, n.key],
          inPane: false,
          inBrowser: false,
          repeat: false,
        });
      collect(n.children, mac, [...path, n.key], out);
    }
  }
  return out;
}

const shortcutCache = new Map<
  boolean,
  { spec: ReturnType<typeof parseSpec>; entry: ShortcutEntry }[]
>();

/** この OS の近道。ブラウザを出しているときだけのもの（inBrowser）を先に並べる（同じキーのほかの近道より先に受けるため）。 */
function shortcuts(mac: boolean) {
  let v = shortcutCache.get(mac);
  if (!v) {
    // 同じキーは、設定で足した近道が既定のものに勝つ
    const all = collect(activeLeader(), mac, [], [])
      .map((entry) => ({ spec: parseSpec(entry.spec), entry }))
      .filter(({ spec }) => !userEntries.some((u) => sameSpec(u.spec, spec)));
    const user = userEntries.flatMap((u) =>
      u.command
        ? [
            {
              spec: u.spec,
              entry: {
                spec: u.text,
                command: u.command,
                inPane: false,
                inBrowser: false,
                repeat: u.repeat,
              },
            },
          ]
        : [],
    );
    v = [
      ...all.filter(({ entry }) => entry.inBrowser),
      ...all.filter(({ entry }) => !entry.inBrowser),
      ...user,
    ];
    shortcutCache.set(mac, v);
  }
  return v;
}

/** 内蔵ブラウザのページに渡す、ページにキーがあっても受けるキー（browser.rs の KeySpec）。 */
export interface InterceptKey extends KeySpec {
  /** リーダーとグループの入口（押したあとのキーも続けて受ける） */
  enter: boolean;
}

/** ページにキーがある間も受けるキー：リーダーと、すべての近道（グループの入口を含む）。 */
export function interceptKeys(mac: boolean): InterceptKey[] {
  const leader = shortcutOf(LEADER_SHORTCUT, mac);
  return [
    ...(leader ? [{ ...parseSpec(leader), enter: true }] : []),
    ...shortcuts(mac).map(({ spec, entry }) => ({
      ...spec,
      enter: !!entry.into,
    })),
  ];
}

/** この OS で、リーダーに入るキーか。 */
export function isLeaderKey(e: KeyLike, mac: boolean): boolean {
  const s = shortcutOf(LEADER_SHORTCUT, mac);
  return !!s && matchSpec(e, parseSpec(s));
}

/**
 * e が当たる、リーダーを通さない近道のコマンド。無ければ null。グループの入口の近道は null（route が受ける）。
 * ブラウザを出しているときだけの近道（shortcutInBrowser）は見ない（route が受ける）。
 */
export function shortcutCommand(e: KeyLike, mac: boolean): Command | null {
  for (const { spec, entry } of shortcuts(mac))
    if (entry.command && !entry.inBrowser && matchSpec(e, spec))
      return entry.command;
  return null;
}

// ---- ユーザーが設定ファイルで足す近道（[gui.shortcuts]。docs/key-design.md の 4.3）----

/** 設定ファイルに書いた近道 1 つ（殻の ConfigShortcut）。command は「コマンドの名前」か「名前:引数」、既定の近道を消すなら none。 */
export interface UserShortcut {
  key: string;
  command: string;
  /** どのファイルに書いたか（0 が config.toml、1 が config.local.toml）。省くと 0 */
  source?: number;
}

interface UserEntry {
  /** 書いたとおりのキー（`?` の一覧に出す） */
  text: string;
  spec: KeySpec;
  /** 動かすコマンド。無ければ（none）、同じキーの既定の近道を消すだけ */
  command?: Command;
  repeat: boolean;
  /** 一覧で行を決める鍵（`id` か `id:引数`） */
  name?: string;
  /** どのファイルに書いたか（大きいほど後で、同じキーならそちらが勝つ） */
  source: number;
}

let userEntries: UserEntry[] = [];

/** コマンドの名前（`id` か `id:引数`）。 */
function commandName(c: Command): string {
  return c.arg === undefined ? c.id : `${c.id}:${c.arg}`;
}

/** 木の中の葉を、コマンドの名前で引けるようにしたもの。 */
function leavesByName(list: Node[], out = new Map<string, Leaf>()) {
  for (const n of list) {
    if (n.type === "group") leavesByName(n.children, out);
    else if (!out.has(commandName(n.run))) out.set(commandName(n.run), n);
  }
  return out;
}

const MODIFIER_NAMES: Record<string, string> = {
  cmd: "Cmd",
  command: "Cmd",
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};

/** 書いたキーを parseSpec の書き方にそろえる（修飾キーの大文字小文字・別名を許す）。読めなければ throw。 */
function parseUserKey(text: string): KeySpec {
  let t = text.trim();
  // キーが + 自身（"Ctrl++"）のとき
  const keyIsPlus = t.endsWith("+");
  if (keyIsPlus) t = t.slice(0, -1).replace(/\+$/, "");
  const parts = t === "" ? [] : t.split("+");
  const keyPart = keyIsPlus ? "+" : (parts.pop() ?? "");
  if (!keyPart) throw new Error("キーがありません");
  const mods = parts.map((m) => {
    const name = MODIFIER_NAMES[m.trim().toLowerCase()];
    if (!name)
      throw new Error(`修飾キー ${m} は使えません（Cmd・Ctrl・Shift・Alt）`);
    return name;
  });
  let name = keyPart;
  if (keyPart.length > 1) {
    name = KEY_NAMES[keyPart.toLowerCase()];
    if (!name)
      throw new Error(
        `キー ${keyPart} は使えません（1 文字、Enter・Tab・Escape・Backspace・Space・矢印（Left など）・F1〜F12）`,
      );
  }
  const spec = parseSpec([...mods, name].join("+"));
  if (!spec.ctrl && !spec.alt && !spec.meta)
    throw new Error(
      "Cmd・Ctrl・Alt のどれかが要ります（字だけのキーはターミナルに届かなくなるため）",
    );
  return spec;
}

/** キーの名前（最後の部分）。大文字小文字を問わず、この書き方にそろえる。1 文字は字・数字・記号。 */
const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  space: "Space",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]),
  ),
};

function sameSpec(a: KeySpec, b: KeySpec): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.meta === b.meta &&
    a.key === b.key
  );
}

/**
 * 設定ファイルの近道を受け入れる。読めたものだけを使い、読めなかったものの理由を返す（呼んだ側がお知らせに出す。起動は止めない）。
 * 同じキーの既定の近道は、設定のほうが勝つ（既定の近道を消すだけなら command に none）。
 * setBrowserEnabled のあとに呼ぶ（内蔵ブラウザを使わないときの browser.* は、使えるコマンドに入らない）。
 */
export function setUserShortcuts(list: UserShortcut[], mac: boolean): string[] {
  const problems: string[] = [];
  const leaves = leavesByName(activeLeader());
  const out: UserEntry[] = [];
  const leader = parseSpec(shortcutOf(LEADER_SHORTCUT, mac) ?? "Ctrl+Shift+K");
  for (const { key, command, source = 0 } of list) {
    const where = `gui.shortcuts."${key}"`;
    let spec: KeySpec;
    try {
      spec = parseUserKey(key);
    } catch (e) {
      problems.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (sameSpec(spec, leader)) {
      problems.push(`${where}: リーダーのキーと同じです`);
      continue;
    }
    let entry: UserEntry;
    if (command === "none") {
      entry = { text: key, spec, repeat: false, source };
    } else {
      const leaf = leaves.get(command);
      if (!leaf) {
        problems.push(`${where}: コマンド ${command} はありません`);
        continue;
      }
      entry = {
        text: key,
        spec,
        command: leaf.run,
        repeat: !!leaf.repeat,
        name: command,
        source,
      };
    }
    // 同じキーは、後のファイル（config.local.toml）が勝つ。同じファイルに 2 回書いたら間違い
    const at = out.findIndex((o) => sameSpec(o.spec, spec));
    if (at < 0) out.push(entry);
    else if (out[at].source === source)
      problems.push(`${where}: 同じキーを 2 回書いています`);
    else if (out[at].source < source) out[at] = entry;
  }
  userEntries = out;
  shortcutCache.clear();
  return problems;
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
  /** リーダーを Esc で出たとき付く（ほかの出方では付かない）。次にリーダーに入るまで残る。App は、リーダーを出たときにだけ読んで、閉じ方を画面のキャラクターに伝える */
  escaped?: boolean;
}

/** リーダーに入っておらず、繰り返しも捨てていない、初めの状態。 */
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
  /** 内蔵ブラウザのタブを出している（shortcutInBrowser の近道を受ける条件。リサイズモードの中は受けない） */
  browser?: boolean;
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
    if (entry.inBrowser && (!env.browser || env.resizeMode)) continue;
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
      repeat: entry.repeat,
    };
  }
  return { consume: false, state };
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
  if (isLeaderKey(e, env.mac)) return out;
  if (e.key === "Escape")
    return { consume: true, state: { ...out.state, escaped: true } };
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

/** 木を上から順に平らにした一覧。設定で足した近道は、そのコマンドの最初の行に添える。 */
export function helpRows(mac: boolean): HelpRow[] {
  return rowsOf(mac, activeLeader(), [], new Set());
}

function rowsOf(
  mac: boolean,
  list: Node[],
  path: string[],
  used: Set<string>,
): HelpRow[] {
  const out: HelpRow[] = [];
  for (const n of list) {
    const p = [...path, nodeKeys(n)];
    let shortcut = shortcutOf(n.shortcut, mac);
    // 設定で同じキーを別のコマンドに割り当てた既定の近道は、もう効かないので出さない
    if (shortcut) {
      const spec = parseSpec(shortcut);
      if (userEntries.some((u) => sameSpec(u.spec, spec))) shortcut = undefined;
    }
    if (n.type === "leaf") {
      const name = commandName(n.run);
      if (!used.has(name)) {
        used.add(name);
        const own = userEntries
          .filter((u) => u.name === name)
          .map((u) => u.text);
        if (own.length)
          shortcut = [shortcut, ...own].filter(Boolean).join(", ");
      }
    }
    out.push({
      path: p,
      label: n.label,
      group: n.type === "group",
      shortcut,
      depth: path.length,
    });
    if (n.type === "group")
      out.push(...rowsOf(mac, n.children, [...path, n.key], used));
  }
  return out;
}

/** リーダーのキー（この OS の書き方）。 */
export function leaderKeyName(mac: boolean): string {
  return shortcutOf(LEADER_SHORTCUT, mac) ?? "";
}
