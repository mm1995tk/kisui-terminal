// 新しい版の知らせの持ち物（C8・#94）。起動時の調べと `kisui update`（手で調べ直す）が同じ知らせ（UpdateBar.tsx）を出す。
import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

import type { UpdateReport } from "../rpc/protocol.ts";

/** 殻（src-tauri/src/update.rs の UpdateInfo）が返す新しい版。 */
export type UpdateInfo = {
  current: string;
  version: string;
  notes: string | null;
};

/** 殻（update.rs の Outcome）が手で調べたときに返す答え。`kisui update` に返すもの（serve の panecmd.UpdateResult）と同じ形（UpdateReport） */
export type UpdateOutcome = UpdateReport;

const [info, setInfo] = createSignal<UpdateInfo | null>(null);

/** いま知らせている新しい版。無ければ null。 */
export { info as updateInfo, setInfo as setUpdateInfo };

/**
 * 起動したときの調べ。新しい版があれば知らせる。見つけたときだけ書く（先に `kisui update` が出した知らせを消さない）。
 * 調べられないのはネットにつながっていないだけのことが多いので、黙る。
 */
export function checkOnStart(): void {
  invoke<UpdateInfo | null>("update_check").then(
    (u) => {
      if (u) setInfo(u);
    },
    () => {},
  );
}

let running: Promise<UpdateOutcome> | null = null;

/**
 * `kisui update`（serve の update.check）が頼んだ調べ直し。新しい版があれば、「あとで」で閉じていても知らせを出し直し、
 * どの答えかを返す（serve が `kisui update` に渡す）。調べている最中に来た頼みは、その調べの答えを返す（問い合わせを重ねない）。
 */
export function checkNow(): Promise<UpdateOutcome> {
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

async function run(): Promise<UpdateOutcome> {
  try {
    const r = await invoke<UpdateOutcome>("update_check_now");
    if (r.status === "available")
      setInfo({
        current: r.current,
        version: r.version,
        notes: r.notes ?? null,
      });
    // 最新（か自動更新を持たない版）なら、前に出した知らせは殻の pending と一緒に無くなっているので消す
    else if (r.status === "latest" || r.status === "manual") setInfo(null);
    return r;
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}

const [busy, setBusy] = createSignal(false);
const [installError, setInstallError] = createSignal("");

/** 入れ替えている最中か。 */
export { busy as updateBusy, installError as updateError };

/**
 * 「更新して再起動」。入れ替えて起動し直す。失敗したら理由を updateError に出す。
 * 知らせのボタン（UpdateBar.tsx）と、リーダーの `n u`（App.tsx）が同じものを呼ぶ。
 */
export async function installUpdate(): Promise<void> {
  if (busy()) return;
  setBusy(true);
  setInstallError("");
  try {
    // うまくいけば起動し直すので、ここには戻らない
    await invoke("update_install");
  } catch (e) {
    setInstallError(String(e));
    setBusy(false);
  }
}

/** 「あとで」。知らせを閉じる（入れ替えている最中は閉じない）。 */
export function dismissUpdate(): void {
  if (!busy()) setInfo(null);
}
