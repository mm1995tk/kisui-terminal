// 新しい版の知らせの持ち物（C8・#94）。起動時の調べと `kisui update`（手で調べ直す）が同じ知らせ（UpdateBar.tsx）を出す。
// 殻への頼みは UpdatesOs にまとめる（本物は infrastructure/tauri/updates.ts）。
import { createSignal, type Accessor } from "solid-js";

import type { UpdateReport } from "../../infrastructure/rpc/protocol.ts";

/** 殻（src-tauri/src/update.rs の UpdateInfo）が返す新しい版。 */
export type UpdateInfo = {
  current: string;
  version: string;
  notes: string | null;
};

/** 殻（update.rs の Outcome）が手で調べたときに返す答え。`kisui update` に返すもの（serve の panecmd.UpdateResult）と同じ形（UpdateReport） */
export type UpdateOutcome = UpdateReport;

/** 新しい版について、外（Tauri の殻。update.rs）に頼むこと。 */
export interface UpdatesOs {
  /** 起動したときの調べ。新しい版があれば返す */
  check(): Promise<UpdateInfo | null>;
  /** 手で調べ直す */
  checkNow(): Promise<UpdateOutcome>;
  /** 入れ替えて起動し直す（うまくいけば戻らない） */
  install(): Promise<void>;
}

export interface Updates {
  /** いま知らせている新しい版。無ければ null。 */
  info: Accessor<UpdateInfo | null>;
  /** 入れ替えている最中か。 */
  busy: Accessor<boolean>;
  /** 入れ替えに失敗した理由（無ければ ""）。 */
  error: Accessor<string>;
  /**
   * 起動したときの調べ。新しい版があれば知らせる。見つけたときだけ書く（先に `kisui update` が出した知らせを消さない）。
   * 調べられないのはネットにつながっていないだけのことが多いので、黙る。
   */
  checkOnStart(): void;
  /**
   * `kisui update`（serve の update.check）が頼んだ調べ直し。新しい版があれば、「あとで」で閉じていても知らせを出し直し、
   * どの答えかを返す（serve が `kisui update` に渡す）。調べている最中に来た頼みは、その調べの答えを返す（問い合わせを重ねない）。
   */
  checkNow(): Promise<UpdateOutcome>;
  /**
   * 「更新して再起動」。入れ替えて起動し直す。失敗したら理由を error に出す。
   * 知らせのボタン（UpdateBar.tsx）と、リーダーの `n u`（features/commands/run.ts）が同じものを呼ぶ。
   */
  install(): Promise<void>;
  /** 「あとで」。知らせを閉じる（入れ替えている最中は閉じない）。 */
  dismiss(): void;
}

/** 新しい版の知らせの持ち物を作る。os は殻への頼み（index.tsx が本物を渡す）。 */
export function createUpdates(os: UpdatesOs): Updates {
  const [info, setInfo] = createSignal<UpdateInfo | null>(null);

  function checkOnStart(): void {
    os.check().then(
      (u) => {
        if (u) setInfo(u);
      },
      () => {},
    );
  }

  let running: Promise<UpdateOutcome> | null = null;

  function checkNow(): Promise<UpdateOutcome> {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  }

  async function run(): Promise<UpdateOutcome> {
    try {
      const r = await os.checkNow();
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
  const [error, setError] = createSignal("");

  async function install(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      // うまくいけば起動し直すので、ここには戻らない
      await os.install();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function dismiss(): void {
    if (!busy()) setInfo(null);
  }

  return { info, busy, error, checkOnStart, checkNow, install, dismiss };
}
