// 新しい版の知らせの持ち物（C8・#94）。起動時の調べと `kisui update`（手で調べ直す）が同じ知らせ（UpdateBar.tsx）を出す。
import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

/** 殻（src-tauri/src/update.rs の UpdateInfo）が返す新しい版。 */
export type UpdateInfo = {
  current: string;
  version: string;
  notes: string | null;
};

/** 殻（update.rs の Outcome）が手で調べたときに返す答え。`kisui update` に返すもの（serve の panecmd.UpdateResult）と同じ形。 */
export type UpdateOutcome =
  | ({ status: "available" } & UpdateInfo)
  | { status: "latest"; current: string }
  | { status: "manual" }
  | { status: "failed"; error: string };

const [info, setInfo] = createSignal<UpdateInfo | null>(null);

/** いま知らせている新しい版。無ければ null。 */
export { info as updateInfo, setInfo as setUpdateInfo };

/** 起動したときの調べ。新しい版があれば知らせる。調べられないのはネットにつながっていないだけのことが多いので、黙る。 */
export function checkOnStart(): void {
  invoke<UpdateInfo | null>("update_check").then(setInfo, () => {});
}

/**
 * `kisui update`（serve の update.check）が頼んだ調べ直し。新しい版があれば、「あとで」で閉じていても知らせを出し直し、
 * どの答えかを返す（serve が `kisui update` に渡す）。
 */
export async function checkNow(): Promise<UpdateOutcome> {
  try {
    const r = await invoke<UpdateOutcome>("update_check_now");
    if (r.status === "available") setInfo(r);
    return r;
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}
