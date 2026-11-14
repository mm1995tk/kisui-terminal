// リーダーの案内を運んでくるキャラクター（実験的）。画像は使う人が設定のフォルダの `mascot/` に置く（README）。
// 画像を読むのは Rust 側（mascot.rs）。画面からはパスを渡さない。置いていない・欠けているときは null で、案内だけが出る。
import { invoke } from "@tauri-apps/api/core";

/** Rust 側（mascot.rs）が返す画像（どれも data: の URL） */
export interface Mascot {
  walk: string[];
  stop: string;
}

/** キャラクターの表示の高さ（px）。幅は画像の縦横比のまま */
export const MASCOT_HEIGHT = 72;
/** 歩く速さ（px/秒）。運ぶときも去るときも同じ。キャラクターの高さの 1.25 倍 / 秒（人がゆっくり歩く速さ） */
export const WALK_SPEED = MASCOT_HEIGHT * 1.25;
/** 歩きの 1 コマを出す時間（ミリ秒）。4 コマで 1 周（0.8 秒）。1 コマで 18px 進む */
export const FRAME_MS = 200;

/** `distance`（px）を一定の速さ（`WALK_SPEED`）で歩く時間（ミリ秒）。距離に比例する */
export function walkDuration(distance: number): number {
  return (Math.max(0, distance) / WALK_SPEED) * 1000;
}

/** 歩き始めてから `elapsed` ミリ秒後に出す歩きのコマ（0 始まり） */
export function walkFrame(elapsed: number, frames = 4): number {
  return Math.floor(Math.max(0, elapsed) / FRAME_MS) % frames;
}

/** OS の「視差効果を減らす」が入っているか */
export function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * `mascot_images` の画像を、全部デコードし終えたもの。`aspect` は `walk-1.png` の幅 / 高さで、表示の幅（`MASCOT_HEIGHT` × `aspect`）を決めるのに使う。
 * `stop` は壊れていると `walk[0]` で代わりにする。
 * `images` は、デコード済みのデータをブラウザが捨てないように、参照を持っておくためのもの。
 */
export type LoadedMascot = Mascot & {
  aspect: number;
  images: HTMLImageElement[];
};

/** 画像 1 枚を読み込んでデコードまで済ませる（運ぶ途中のコマの切り替えで、一瞬消えないように）。壊れていれば null */
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

/** 画像を読む（全部デコードしてから返す）。使えなければ null。歩く 4 枚が 1 枚でも壊れていれば使えない。`stop` が壊れているときは、無いときと同じ扱い */
export async function loadMascot(): Promise<LoadedMascot | null> {
  try {
    const m = (await invoke("mascot_images")) as Mascot | null;
    if (!m || m.walk.length !== 4) return null;
    const [walk, stop] = await Promise.all([
      Promise.all(m.walk.map(decode)),
      decode(m.stop),
    ]);
    if (walk.some((i) => i === null)) return null;
    const frames = walk as HTMLImageElement[];
    const aspect = frames[0].naturalWidth / frames[0].naturalHeight;
    if (!Number.isFinite(aspect) || aspect <= 0) return null;
    return {
      walk: m.walk,
      stop: stop ? m.stop : m.walk[0],
      aspect,
      images: [...frames, ...(stop ? [stop] : [])],
    };
  } catch {
    return null;
  }
}

/** 案内の開閉に応じて、キャラクターがすること（運ぶ・去る・消す） */
export function nextAction(s: {
  isOpen: boolean;
  wasOpen: boolean | undefined;
  /** 画像が使えるか（4 枚そろって読めた） */
  hasMascot: boolean;
  reduced: boolean;
  /** 今キャラクターが出ているか */
  shown: boolean;
}): "carry" | "leave" | "clear" {
  if (!s.hasMascot || s.reduced) return "clear";
  if (s.isOpen) return "carry";
  return s.wasOpen && s.shown ? "leave" : "clear";
}
