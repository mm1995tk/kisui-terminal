// リーダーの案内を運んでくるキャラクター（実験的）。形式は docs/mascot.md。
// キャラクターは設定のフォルダの `mascot/<名前>/` に置き、設定ファイルの `[gui] mascot` で選ぶ。
// `mascot.toml` と画像を読むのは Rust 側（mascot.rs）。画面からはパスを渡さない（画像は `mascot:` のスキームの番号で受け取る）。
// 選んでいない・使えないときは null で、案内だけが出る。
import { T } from "./i18n/index.ts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** 場面 1 つ（Rust 側の mascot.rs の `Scene`）。既定の値は Rust 側が埋めてある */
export interface MascotScene {
  /** コマの画像（Rust 側からは番号、読んだ後は URL）。1 枚なら静止画 */
  frames: string[];
  /** 1 コマの時間（ミリ秒） */
  frameMs: number;
  /** 最後のコマのあと最初に戻るか（false は最後のコマで止まる） */
  loop: boolean;
  /** 動く速さ（px/秒）。動く場面（運ぶ・押していく）だけが使う */
  speed: number;
}

/** キャラクター 1 つ分（Rust 側の `Character`）。無い場面は null か空の並び */
export interface Mascot {
  carry: MascotScene;
  sigh: MascotScene | null;
  /** 休憩の具体。一息つく場面になってから `restAfterMs` 経つと、1 つをランダムに選んで動かす */
  rest: MascotScene[];
  /** 一息つく場面になってから休憩に入るまでの待ち時間（ミリ秒） */
  restAfterMs: number;
  bye: MascotScene[];
  /** 押していく。リーダーを Esc で閉じたとき、案内を右へ押して画面の外まで持っていく。無ければ運ぶ場面を使う */
  push: MascotScene | null;
}

/** キャラクターの表示の高さ（px）。幅は画像の縦横比のまま */
export const MASCOT_HEIGHT = 72;

/** `distance`（px）を一定の速さ `speed`（px/秒）で動く時間（ミリ秒）。距離に比例する */
export function travelDuration(distance: number, speed: number): number {
  if (!(speed > 0)) return 0;
  return (Math.max(0, distance) / speed) * 1000;
}

/** 場面を始めてから `elapsed` ミリ秒後に出すコマ（0 始まり）。くり返さない場面は最後のコマで止まる */
export function sceneFrame(scene: MascotScene, elapsed: number): number {
  const n = scene.frames.length;
  const i = Math.floor(Math.max(0, elapsed) / scene.frameMs);
  return scene.loop ? i % n : Math.min(i, n - 1);
}

/** 1 回再生し終えるまでの時間（ミリ秒。さようならの長さ） */
export function playOnceDuration(scene: MascotScene): number {
  return scene.frames.length * scene.frameMs;
}

/** 押していく速さの既定（px/秒。Rust 側 mascot.rs の `DEFAULT_SPEED` と同じ） */
export const DEFAULT_PUSH_SPEED = 90;

/** 押していくときの場面。`[push]` が無ければ、運ぶ場面のコマ・コマの時間・くり返しを使い、速さは既定（運ぶ場面の速さは借りない） */
export function pushScene(m: Pick<Mascot, "carry" | "push">): MascotScene {
  return m.push ?? { ...m.carry, speed: DEFAULT_PUSH_SPEED };
}

/** 運び終えて止まっているときの姿（一息つく場面。無ければ運ぶ場面の 1 コマ目で止まる） */
export function restingScene(m: Pick<Mascot, "carry" | "sigh">): MascotScene {
  return m.sigh ?? { ...m.carry, frames: [m.carry.frames[0]], loop: false };
}

/** 具体（さようなら・休憩）を 1 つ選ぶ（`random` は 0 以上 1 未満）。無ければ null */
export function pickVariant(
  list: MascotScene[],
  random: number,
): MascotScene | null {
  if (list.length === 0) return null;
  const i = Math.min(list.length - 1, Math.floor(random * list.length));
  return list[Math.max(0, i)];
}

/** OS の「視差効果を減らす」が入っているか */
export function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 読み込みとデコードを済ませたキャラクター。`aspect` は運ぶ場面の 1 コマ目の幅 / 高さで、運ぶ距離を決めるのに使う。
 * `images` は、デコード済みのデータをブラウザが捨てないように、参照を持っておくためのもの。
 */
export type LoadedMascot = Mascot & {
  aspect: number;
  images: HTMLImageElement[];
};

/** 画像 1 枚を読み込んでデコードまで済ませる（コマの切り替えで、一瞬消えないように）。壊れていれば null */
async function decode(src: string): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/**
 * デコードできない画像が 1 枚でもある場面を外す（その場面が無いのと同じ）。運ぶ場面が使えなければ null。
 * `usable` は画像（URL）が使えるか。
 */
export function usableMascot(
  m: Mascot,
  usable: (frame: string) => boolean,
): Mascot | null {
  const ok = (s: MascotScene | null): MascotScene | null =>
    s && s.frames.length > 0 && s.frames.every(usable) ? s : null;
  const carry = ok(m.carry);
  if (!carry) return null;
  const many = (list: MascotScene[]) => list.filter((s) => ok(s) !== null);
  return {
    carry,
    sigh: ok(m.sigh),
    rest: many(m.rest),
    restAfterMs: m.restAfterMs,
    bye: many(m.bye),
    push: ok(m.push),
  };
}

/** 全部の場面の画像を `f` で置き換える */
export function mapFrames(m: Mascot, f: (frame: string) => string): Mascot {
  const scene = (s: MascotScene): MascotScene => ({
    ...s,
    frames: s.frames.map(f),
  });
  return {
    carry: scene(m.carry),
    sigh: m.sigh && scene(m.sigh),
    rest: m.rest.map(scene),
    restAfterMs: m.restAfterMs,
    bye: m.bye.map(scene),
    push: m.push && scene(m.push),
  };
}

/** Rust 側から受け取ったキャラクターの画像を全部デコードして、使える形にする。使えなければ null */
async function decodeMascot(raw: Mascot): Promise<LoadedMascot | null> {
  const m = mapFrames(raw, (id) => convertFileSrc(id, "mascot"));
  const urls = new Set<string>();
  for (const s of [m.carry, m.sigh, m.push, ...m.rest, ...m.bye]) {
    for (const f of s?.frames ?? []) urls.add(f);
  }
  const decoded = new Map(
    await Promise.all(
      [...urls].map(async (u) => [u, await decode(u)] as const),
    ),
  );
  const usable = usableMascot(m, (u) => !!decoded.get(u));
  if (!usable) return null;
  const first = decoded.get(usable.carry.frames[0]);
  const aspect = first ? first.naturalWidth / first.naturalHeight : NaN;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const images = [...decoded.values()].filter(
    (i): i is HTMLImageElement => i !== null,
  );
  return { ...usable, aspect, images };
}

/** 設定で選んだキャラクターを読む（全部デコードしてから返す）。使えなければ null */
export async function loadMascot(): Promise<LoadedMascot | null> {
  try {
    const raw = (await invoke("mascot_load")) as Mascot | null;
    return raw ? await decodeMascot(raw) : null;
  } catch {
    return null;
  }
}

/** Rust 側が付けた画像の番号（`<世代>-<番号>`）の世代 */
export function generationOf(m: Pick<Mascot, "carry">): number {
  return Number.parseInt(m.carry.frames[0], 10);
}

/** 読み直した結果（リーダーの `c r`）。`none` は、キャラクターを選んでいない */
export type Reloaded =
  | { kind: "loaded"; mascot: LoadedMascot }
  | { kind: "none" }
  | { kind: "error"; error: string };

/** 今選んでいるキャラクターを、`mascot.toml` と画像から読み直す。使えなければ理由を返す（前のキャラクターは、呼んだ側がそのまま使う） */
export async function reloadMascot(): Promise<Reloaded> {
  try {
    const raw = (await invoke("mascot_reload")) as Mascot | null;
    if (!raw) return { kind: "none" };
    const mascot = await decodeMascot(raw);
    if (!mascot) return { kind: "error", error: T("mascot.err.image") };
    // デコードできたので、読み直した画像を使うものにする（できなければ、前のキャラクターの画像の URL が使えるまま残る）
    await invoke("mascot_commit", { generation: generationOf(raw) });
    return { kind: "loaded", mascot };
  } catch (e) {
    return { kind: "error", error: String(e) };
  }
}

/** 一覧の 1 行（Rust 側の mascot.rs の `Entry`） */
export interface MascotEntry {
  name: string;
  /** 使えないときの理由。使えれば null */
  error: string | null;
}

/** 選べるキャラクターの一覧（Rust 側の `Listing`） */
export interface MascotListing {
  /** キャラクターの置き場（`mascot/`） */
  root: string;
  /** 今選んでいるキャラクターの名前。選んでいなければ null */
  current: string | null;
  entries: MascotEntry[];
}

/** `mascot/` の中のキャラクターの一覧と、今選んでいるもの */
export function listMascots(): Promise<MascotListing> {
  return invoke("mascot_list");
}

/** キャラクターを選び、`config.local.toml` に書く。書けなければ理由で失敗する。読み込みは `reloadMascot` で別に行う */
export async function selectMascot(name: string): Promise<void> {
  await invoke("mascot_select", { name });
}

/** リーダーの閉じ方。`escape` は Esc。`other` はそれ以外（リーダーのキー・操作の実行・一覧に無いキー・窓のフォーカスが外れた、など） */
export type CloseReason = "escape" | "other";

/**
 * 案内の開閉に応じて、キャラクターがすること。
 * - carry: 運ぶ。still: 動かさずに右下に出す（視差効果を減らすとき）
 * - push: 押していく（Esc で閉じたときだけ。案内を右へ押して画面の外へ持っていく）
 * - bye: さようなら（その場で 1 回再生して消える）。clear: その場ですぐ消す
 */
export function nextAction(s: {
  isOpen: boolean;
  wasOpen: boolean | undefined;
  /** キャラクターが使えるか */
  hasMascot: boolean;
  reduced: boolean;
  /** 今キャラクターが出ているか */
  shown: boolean;
  /** 閉じ方。Esc で閉じたときだけ押していく */
  closedBy: CloseReason;
}): "carry" | "still" | "push" | "bye" | "clear" {
  if (!s.hasMascot) return "clear";
  if (s.isOpen) return s.reduced ? "still" : "carry";
  if (!s.wasOpen || !s.shown || s.reduced) return "clear";
  return s.closedBy === "escape" ? "push" : "bye";
}
