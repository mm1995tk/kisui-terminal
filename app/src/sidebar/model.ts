// 左の一覧（D1）に出すものを、接続の状態とワークスペースの一覧から組み立てる。
// 画面の仕組み（Solid）には依存しない。描くのは Sidebar.tsx。
//
// 見た目は親 #271 のモック（「案：フラットな一覧」）に従う：マシンは見出し、ワークスペースは帯で、
// どちらも同じ左端にそろえる。ツリー（D2）は tree/、上下の固定（D3）は splitAtFocus と Sidebar.tsx、
// マシンごとの色（D4）の決め方と保存は colors.ts。

import type { Workspace, WorkspaceId } from "../rpc/protocol.ts";
import { LOCAL } from "../ssh/api.ts";
import { LOCAL_LABEL } from "../ssh/machines.ts";
import type { SessionState } from "../ssh/session.ts";
import { MACHINE_COLORS } from "./colors.ts";

/** GUI がフォーカスしているワークスペース（どのマシンの、どれか）。 */
export interface WorkspaceFocus {
  target: string;
  id: WorkspaceId;
}

/** 見出しの横の丸。つながっている・つなぎ直している・それ以外。 */
export type Health = "up" | "pending" | "down";

/** フォルダが決まっていないワークスペースの帯の名前。 */
export const UNSET_TITLE = "（フォルダ未定）";

/** ワークスペース 1 つ分の帯に出すもの。 */
export interface Band {
  id: WorkspaceId;
  /** 帯の名前。目印（.git / .shijimi-editor/）が無いワークスペースはフォルダのパス。フォルダ未定なら UNSET_TITLE */
  title: string;
  /** ユーザーがつけた名前（無ければ ""。title は、あればこれになる） */
  label: string;
  /** 名前をつけていないときの title（名前を変える窓の「空なら」に出す） */
  autoTitle: string;
  /** title がパスなら true（等幅で出す） */
  path: boolean;
  /** フォルダ未定か */
  unset: boolean;
  /** 右に小さく出すもの（ブランチ、「git なし」、同じフォルダの 2 つ目からの番号） */
  detail: string;
  /** ツールチップに出すフォルダのパス（未定なら ""） */
  root: string;
  focused: boolean;
  /** プライマリターミナルで TUI の shj が動いているか。動いているときだけツリーを出す */
  showTree: boolean;
}

/** マシン 1 台分（見出しと、その下の帯）に出すもの。 */
export interface MachineGroup {
  target: string;
  /** 見出しの文字（ローカル / 付けた名前 / ssh の行き先） */
  label: string;
  /** 名前を変えたり外したり切ったりできるか（「ローカル」はできない） */
  removable: boolean;
  /** 設定ファイル（config.toml の [[gui.machines]]）で決めたマシンか。外せず、名前も変えられない */
  fixed: boolean;
  /** マシンの色（D4）。見出しと帯の左端の線などに使う */
  color: string;
  health: Health;
  bands: Band[];
}

/** つなぎ先の表示名（名前を付けていないとき）。 */
export const machineLabel = (t: string): string =>
  t === LOCAL ? LOCAL_LABEL : t;

/** 見出しの丸の色分け。 */
export function health(s: SessionState | undefined): Health {
  switch (s?.kind) {
    case "connected":
      return "up";
    case "connecting":
    case "reconnecting":
    case "installing":
      return "pending";
    default:
      return "down";
  }
}

/**
 * ワークスペース 1 つを帯にする。nth は、同じマシンで同じフォルダを指す何番目のワークスペースか（1 から）。
 * 同じフォルダのワークスペースは名前が同じになるので、2 つ目からは番号を付けて見分ける。
 * ユーザーがつけた名前（w.label）があれば、帯の名前はそれになる（番号は付けない。ブランチなどはそのまま出す）。
 */
export function band(w: Workspace, focused: boolean, nth = 1): Band {
  const label = w.label ?? "";
  const auto = autoBand(w, focused, label ? 1 : nth);
  if (!label) return auto;
  return { ...auto, title: label, label, path: false, unset: false };
}

function autoBand(w: Workspace, focused: boolean, nth: number): Band {
  const num = nth > 1 ? `#${nth}` : "";
  if (w.folder === null) {
    return {
      id: w.id,
      title: UNSET_TITLE,
      label: "",
      autoTitle: UNSET_TITLE,
      path: false,
      unset: true,
      detail: "",
      root: "",
      focused,
      showTree: w.primaryShj != null,
    };
  }
  const shown = w.display || w.folder;
  const title = w.kind === "cwd" ? shown : w.name || shown;
  const detail = (w.kind === "cwd" ? ["git なし"] : [w.branch ?? ""])
    .concat(num)
    .filter(Boolean)
    .join(" ");
  return {
    id: w.id,
    title,
    label: "",
    autoTitle: title,
    path: w.kind === "cwd" || !w.name,
    unset: false,
    detail,
    root: w.folder,
    focused,
    showTree: w.primaryShj != null,
  };
}

/**
 * 一覧を組み立てる。targets はつないだ（つなごうとしている）つなぎ先で、この順に並べる。
 * 帯は shj の workspace.list と同じく作った順。
 * colors はつなぎ先 → 色（colors.ts の machineColors）。無いつなぎ先は候補の最初の色にする。
 * labelOf は見出しの文字（省くと machineLabel）。
 * fixedOf は設定ファイルで決めたマシンか（省くと全部 false）。
 */
export function buildSidebar(
  targets: string[],
  states: Record<string, SessionState | undefined>,
  workspaces: Record<string, Workspace[] | undefined>,
  focus: WorkspaceFocus | null,
  colors: Record<string, string> = {},
  labelOf: (target: string) => string = machineLabel,
  fixedOf: (target: string) => boolean = () => false,
): MachineGroup[] {
  return targets.map((target) => {
    const ws = workspaces[target] ?? [];
    const seen = new Map<string, number>();
    const nth = ws.map((w) => {
      if (w.folder === null || w.label) return 1; // 名前をつけたものは、番号を数えない（帯にも付けない）
      const n = (seen.get(w.folder) ?? 0) + 1;
      seen.set(w.folder, n);
      return n;
    });
    return {
      target,
      label: labelOf(target),
      removable: target !== LOCAL,
      fixed: fixedOf(target),
      color: colors[target] ?? MACHINE_COLORS[0],
      health: health(states[target]),
      bands: ws.map((w, i) =>
        band(w, focus?.target === target && focus.id === w.id, nth[i]),
      ),
    };
  });
}

/**
 * shj が教えてくれたフォーカスを GUI のフォーカスに反映する。GUI のフォーカスは 1 つなので、
 * フォーカスが無ければそれを使い、同じマシンのものなら追い（null なら外す）、別のマシンのものでは動かさない。
 */
export function adoptFocus(
  current: WorkspaceFocus | null,
  target: string,
  shjFocus: WorkspaceId | null,
): WorkspaceFocus | null {
  if (current) {
    // 同じマシンで shj のフォーカスが変われば追い、消えれば外す
    if (current.target === target && shjFocus !== current.id) {
      return shjFocus === null ? null : { target, id: shjFocus };
    }
    return current;
  }
  return shjFocus === null ? null : { target, id: shjFocus };
}

/**
 * 一覧が変わった・切った・フォーカスが外れたあとに、フォーカス先がまだあるかを確かめる。
 * 無くなっていたら、先に決めておいた移り先（prefer。フォーカスしているワークスペースを閉じたときの隣）が一覧にあればそれを、
 * 無ければほかのマシンの shj のフォーカス（shjFocus の順）のうち一覧にあるものを使う
 * （起動直後の「先に分かったものを使う」に合わせ、印の無い状態を続けない）。どれも無ければ null。
 */
export function keepFocus(
  current: WorkspaceFocus | null,
  workspaces: Record<string, Workspace[] | undefined>,
  shjFocus: Record<string, WorkspaceId | null | undefined> = {},
  prefer: WorkspaceFocus | null = null,
): WorkspaceFocus | null {
  const exists = (f: WorkspaceFocus) =>
    workspaces[f.target]?.some((w) => w.id === f.id) ?? false;
  if (current && exists(current)) return current;
  if (prefer && exists(prefer)) return prefer;
  for (const [target, id] of Object.entries(shjFocus)) {
    if (id == null) continue;
    const f = { target, id };
    if (exists(f)) return f;
  }
  return null;
}

/**
 * フォーカスしているワークスペースを閉じたあと、移り先（moveTo）を shj に workspace.focus で伝えてよいか。
 * GUI のフォーカスがまだ移り先を指していて、移り先が一覧に残っているときだけ true。
 * 閉じる返事を待つあいだにユーザーが別の帯を選んだ・移り先も閉じられた、なら伝えない
 * （選んだフォーカスを古い移り先で上書きしない。無いワークスペースに移ろうとして断られない）。
 */
export function shouldSendMoveTo(
  current: WorkspaceFocus | null,
  moveTo: WorkspaceFocus,
  workspaces: Record<string, Workspace[] | undefined>,
): boolean {
  return (
    current?.target === moveTo.target &&
    current.id === moveTo.id &&
    (workspaces[moveTo.target]?.some((w) => w.id === moveTo.id) ?? false)
  );
}

/**
 * 上下の固定（D3）のために、一覧をフォーカスしている帯の前後で分けたもの。
 * フォーカスしている帯までは上から順に流し（そのマシンの見出しと帯は上に固定する）、
 * それより後ろの帯とマシンは、まとめて下に固定する。
 */
export interface SplitSidebar {
  /** フォーカスしている帯のマシンより前のマシン */
  before: MachineGroup[];
  /** フォーカスしている帯のマシン。帯はフォーカスしている帯まで。フォーカスが無ければ null */
  focused: MachineGroup | null;
  /** 下に固定するもの。rest はフォーカスしているマシンの残りの帯、groups はそれより後ろのマシン */
  after: {
    target: string;
    label: string;
    color: string;
    rest: Band[];
    groups: MachineGroup[];
  };
}

/** 一覧をフォーカスしている帯の前後で分ける。フォーカスが無ければ全部 before。 */
export function splitAtFocus(groups: MachineGroup[]): SplitSidebar {
  const gi = groups.findIndex((g) => g.bands.some((b) => b.focused));
  if (gi < 0) {
    return {
      before: groups,
      focused: null,
      after: { target: "", label: "", color: "", rest: [], groups: [] },
    };
  }
  const g = groups[gi];
  const bi = g.bands.findIndex((b) => b.focused);
  return {
    before: groups.slice(0, gi),
    focused: { ...g, bands: g.bands.slice(0, bi + 1) },
    after: {
      target: g.target,
      label: g.label,
      color: g.color,
      rest: g.bands.slice(bi + 1),
      groups: groups.slice(gi + 1),
    },
  };
}

/** キーで移る向き。サイドバーで下・次は "next"、上・前は "prev"。 */
export type Step = "next" | "prev";

/** 移り先。ws が null のマシンは、ワークスペースが 1 つも無い（マシンだけを選ぶ）。 */
export interface StepTarget {
  target: string;
  ws: WorkspaceId | null;
}

/**
 * キーで続けて移るときの起点。移っている途中（返事を待っている）なら向かっている先、そうでなければ今のフォーカス。
 * 返事が返るまでフォーカスは前のままなので、起点を向かっている先にしないと、続けて押しても 1 つしか進まない。
 */
export function stepFrom(
  heading: WorkspaceFocus | null,
  current: WorkspaceFocus | null,
): WorkspaceFocus | null {
  return heading ?? current;
}

/**
 * サイドバーの次・前のワークスペース（マシンをまたいで、上から下へ並べた並びで）。端では反対の端へ回る。
 * 今のフォーカスが無い（または並びに無い）ときは、次なら先頭、前なら末尾。ワークスペースが 1 つも無ければ null。
 * picked は、w h / w l で止まった（選んでいる）マシン。有れば、フォーカスではなくそのマシンの位置を起点にする
 * （次ならそのマシンより下の最初の、前なら上の最後のワークスペース。無ければ反対の端へ回る）。
 */
export function stepWorkspace(
  groups: readonly StepGroup[],
  current: WorkspaceFocus | null,
  step: Step,
  picked: string | null = null,
): WorkspaceFocus | null {
  const at =
    picked === null ? -1 : groups.findIndex((g) => g.target === picked);
  if (at >= 0) {
    const side = step === "next" ? groups.slice(at) : groups.slice(0, at + 1);
    const ws = side.flatMap((g) =>
      g.bands.map((b) => ({ target: g.target, id: b.id })),
    );
    const hit = step === "next" ? ws[0] : ws[ws.length - 1];
    if (hit) return hit;
  }
  const all = groups.flatMap((g) =>
    g.bands.map((b) => ({ target: g.target, id: b.id })),
  );
  if (all.length === 0) return null;
  const i = current
    ? all.findIndex((w) => w.target === current.target && w.id === current.id)
    : -1;
  if (i < 0 || at >= 0) return step === "next" ? all[0] : all[all.length - 1];
  return all[(i + (step === "next" ? 1 : all.length - 1)) % all.length];
}

/**
 * 前・次のマシン。端では反対の端へ回る。ワークスペースが 1 つも無いマシンにも止まる（ws は null）。
 * 移り先のワークスペースは、そのマシンで最後に選んでいたもの（lastOf。今も有るもの）、無ければ先頭。
 * 今のマシンが分からない（無い）ときは、次なら先頭のマシン、前なら末尾のマシン。
 */
export function stepMachine(
  groups: readonly StepGroup[],
  current: string | undefined,
  step: Step,
  lastOf: (target: string) => WorkspaceId | undefined = () => undefined,
): StepTarget | null {
  if (groups.length === 0) return null;
  const i = groups.findIndex((g) => g.target === current);
  const n = groups.length;
  const j =
    i < 0
      ? step === "next"
        ? 0
        : n - 1
      : (i + (step === "next" ? 1 : n - 1)) % n;
  const g = groups[j];
  const last = lastOf(g.target);
  const ws = g.bands.find((b) => b.id === last)?.id ?? g.bands[0]?.id ?? null;
  return { target: g.target, ws };
}

/** stepWorkspace・stepMachine が使う、マシン 1 台分の項目（MachineGroup の一部）。 */
export interface StepGroup {
  target: string;
  bands: readonly { id: WorkspaceId }[];
}
