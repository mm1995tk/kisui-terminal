import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 通知を出した欄が、押された・閉じられたを受け取る関数 */
type Handler = (kind: "activated" | "closed") => void;

let seq = 0;
const pending = new Map<number, Handler>();
let listening: Promise<unknown> | undefined;

/** Rust 側（notify.rs）が返す押された・閉じられたを、通知を出した欄へ渡す。 */
function ensureListening(): Promise<unknown> {
  listening ??= listen<{ key: number; kind: "activated" | "closed" }>(
    "notify-response",
    (e) => {
      const h = pending.get(e.payload.key);
      // 通知は 1 回しか返らない。返ったら対応を消す
      pending.delete(e.payload.key);
      h?.(e.payload.kind);
    },
  );
  return listening;
}

/**
 * OS の通知を出す。`onResponse` は押された・閉じられたのとき 1 回だけ呼ばれる。出せなければ例外。
 * `focus` が真なら、押されたとき Rust 側が窓を前に出す。
 * 返す関数は、欄が無くなるときに呼ぶ（以後の返事を捨てる）。
 */
export async function showOsNotification(
  n: { title: string; body?: string },
  focus: boolean,
  onResponse: Handler,
): Promise<() => void> {
  await ensureListening();
  const key = ++seq;
  pending.set(key, onResponse);
  try {
    await invoke("notify_show", { key, title: n.title, body: n.body, focus });
  } catch (e) {
    pending.delete(key);
    throw e;
  }
  return () => pending.delete(key);
}
