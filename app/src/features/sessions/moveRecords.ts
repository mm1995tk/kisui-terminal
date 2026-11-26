// 前の版が webview の localStorage に記録した「窓で足したマシン」を、この版で最初に起動したときに config.local.toml に移す。
// 移したあとは記録を読まない（MOVED_KEY に印を付ける）。記録そのものは消さずに残す（前の版に戻したときに、そのまま使えるように）。
//
// 移すマシンは、前の版のサイドバーに出ていたものだけ（mergeMachines と同じ決まり）：
// - 設定ファイル（config.toml・config.local.toml）に同じ ssh の行き先のマシンがあれば、設定ファイルのものを残し、記録は移さない。
// - 名前（無ければ ssh の行き先）が設定ファイルのマシンと重なる記録は、前の版でも出ていなかったので移さない。
// 並びは記録の順で、設定ファイルのマシンの後ろに続く（前の版のサイドバーと同じ並び）。
//
// config.local.toml に書けない（読み取り専用・壊れている、など）ときは、そこで止め、印を付けない（次の起動でまた移す）。
// そのときは、移せなかったマシンを知らせに出す。殻の確かめで断られた 1 台（使えない名前など）は飛ばして続け、知らせに出す。
// 起動のとき、窓を出す前に 1 度だけ呼ぶ（ui/main-window/page.tsx）。

import { T } from "../../i18n/index.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import type { Problem } from "../problem.ts";
import {
  loadMachines,
  machineEditError,
  type ConfigMachine,
  type Machine,
} from "./machines.ts";
import type { ShellApi } from "./shell.ts";

/** 記録を config.local.toml に移し終えた印（localStorage のキー。値は "1"）。 */
export const MOVED_KEY = "kisui-terminal.machinesMoved";

/** 記録のうち、config.local.toml に移すマシン（前の版のサイドバーに出ていたもの）。 */
export function recordsToMove(
  config: ConfigMachine[],
  saved: Machine[],
): Machine[] {
  const labels = new Set(config.map((c) => c.name || c.ssh));
  return saved.filter(
    (m) =>
      !config.some((c) => c.ssh === m.target) &&
      !labels.has(m.name ?? m.target),
  );
}

/**
 * 前の版の記録を config.local.toml に移し、移したあとのマシンの一覧（殻の config_gui の machines と同じ形）を返す。
 * 移せなかったマシンがあれば、知らせ（problem）も返す。移すものが無ければ、config をそのまま返す。
 */
export async function moveMachineRecords(deps: {
  api: Pick<ShellApi, "editMachine">;
  store: KeyValueStore | undefined;
  config: ConfigMachine[];
}): Promise<{ machines: ConfigMachine[]; problem?: Problem }> {
  const { api, store } = deps;
  let machines = deps.config;
  if (!store) return { machines };
  try {
    if (store.getItem(MOVED_KEY)) return { machines };
  } catch {
    return { machines };
  }
  const todo = recordsToMove(machines, loadMachines(store));
  const skipped: string[] = [];
  for (const [i, m] of todo.entries()) {
    try {
      machines = await api.editMachine({
        kind: "add",
        ssh: m.target,
        name: m.name ?? null,
      });
    } catch (e) {
      const why = machineEditError(e);
      if (isRefusedEntry(e)) {
        // この 1 台だけが使えない（名前の重なりなど）。飛ばして続ける
        skipped.push(`${m.name ?? m.target}: ${why}`);
        continue;
      }
      // ファイルに書けない。残りは次の起動でまた移す（印を付けない）
      const left = todo
        .slice(i)
        .map((x) => x.name ?? x.target)
        .join(", ");
      return {
        machines,
        problem: {
          title: T("machine.move.failed.title"),
          error: `${why}\n${T("machine.move.failed.left", { machines: left })}`,
        },
      };
    }
  }
  try {
    store.setItem(MOVED_KEY, "1");
  } catch {
    // 印を書けなくても、次の起動では移したマシンが設定ファイルにあるので、同じものは移さない
  }
  return skipped.length === 0
    ? { machines }
    : {
        machines,
        problem: {
          title: T("machine.move.skipped.title"),
          error: skipped.join("\n"),
        },
      };
}

/** その 1 台だけが断られた（ファイルは書ける）。 */
function isRefusedEntry(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("kind" in e)) return false;
  const kind = (e as { kind: unknown }).kind;
  return kind === "exists" || kind === "entry" || kind === "rejected";
}
