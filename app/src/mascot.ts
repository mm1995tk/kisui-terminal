// リーダーの案内を運んでくるキャラクター（実験的）。画像は使う人が設定のフォルダの `mascot/` に置く（README）。
// 画像を読むのは Rust 側（mascot.rs）。画面からはパスを渡さない。置いていない・欠けているときは null で、案内だけが出る。
import { invoke } from "@tauri-apps/api/core";

/** Rust 側（mascot.rs）が返す画像（どれも data: の URL） */
export interface Mascot {
  walk: string[];
  stop: string;
  leave: string | null;
}

/** 案内を運ぶ時間（ミリ秒） */
export const CARRY_MS = 600;
/** 歩きの 1 コマを出す時間（ミリ秒）。4 コマで 1 周 */
export const FRAME_MS = 120;
/** 去る動きの時間（ミリ秒） */
export const LEAVE_MS = 500;
/** キャラクターの表示の高さ（px）。幅は画像の縦横比のまま */
export const MASCOT_HEIGHT = 72;

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

/** 画像を読む。使えなければ null。画像の縦横比（幅 / 高さ）も返す */
export type LoadedMascot = Mascot & { aspect: number };

export async function loadMascot(): Promise<
  (Mascot & { aspect: number }) | null
> {
  try {
    const m = (await invoke("mascot_images")) as Mascot | null;
    if (!m || m.walk.length !== 4) return null;
    const aspect = await new Promise<number>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth / img.naturalHeight);
      img.onerror = () => reject(new Error("mascot image"));
      img.src = m.walk[0];
    });
    return Number.isFinite(aspect) && aspect > 0 ? { ...m, aspect } : null;
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
  hasLeave: boolean;
  /** 今キャラクターが出ているか */
  shown: boolean;
}): "carry" | "leave" | "clear" {
  if (!s.hasMascot || s.reduced) return "clear";
  if (s.isOpen) return "carry";
  return s.wasOpen && s.hasLeave && s.shown ? "leave" : "clear";
}
