// `kisui machine`（#514）：Pane の中のコマンドが Window に頼む、Machine の一覧と操作（add・rename・remove・disconnect・reconnect・
// terminal）。commands/windowRun.ts の受け持ちの表を作る。行うことは Machines の Dialog（リーダーの m。MachineDialog.tsx）の
// a・n・d・x・r・t と同じで、できるかの決まりも同じ（machineList.ts の canDo）。違いは、相手の Machine を引数（名前か ssh の行き先）で
// 指すことと、Dialog を出さないこと。書き先も Dialog と同じ config.local.toml（「ローカル」のターミナルの始め方は [server]）。
// 画面にも Tauri にも触らない。
//
// 受けるのは、手元の PC の Pane の頼みだけ（どの受け持ちにも remote を書かない。createWindowRun が、ほかを断る）。
// Machine の設定（接続先・ssh・config.local.toml）を変え、接続を切れるので、リモートの Machine の Pane から頼めると、
// 接続先をすり替える・手元の PC の設定を書き換える抜け道になる。allow_pane_to があっても、許している間（p）でも受けない。
// 一覧も、手元の PC の ssh の行き先を教えるので、同じく手元の PC の Pane だけ。
// Dialog の p・P（手元の PC の Pane の操作を、時間を決めて許す・終える）は CLI にしない。許しは Window の前の人だけが付ける。
import { T } from "../../i18n/index.ts";
import {
  argFlag,
  argOptionalString,
  argString,
  WindowCommandError,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import { canDo, type MachineAction, type MachineRow } from "./machineList.ts";
import { machineCliName, machineTarget, type Machine } from "./machines.ts";
import { LOCAL } from "./shell.ts";
import type { TermDefaults } from "./termDefaults.ts";

/** `kisui machine list --json` の 1 つ（cmd/kisui/machine.go の machineInfo と同じ形）。 */
export interface MachineInfo {
  /** CLI での名前（付けた名前、無ければ ssh の行き先。手元の PC は local） */
  name: string;
  /** ssh の行き先（手元の PC は無い） */
  ssh?: string;
  /** つながっているか */
  connected: boolean;
  /** つながりの状態の 1 行（Dialog の行と同じ言葉） */
  status: string;
  /** その Machine の Terminal tab の数 */
  terminalTabs: number;
  /** config.toml にだけある Machine（Window からは変えられない） */
  fixed?: true;
}

/** `kisui machine terminal` の答え（cmd/kisui/machine.go の terminalInfo と同じ形）。書いていない項目は無い。 */
export interface TerminalInfo {
  startDir?: string;
  shell?: string;
}

/** Machine の操作のうち、ここが使うもの（sessions/controller.ts の createSessions の持ち物）。 */
export interface MachineOps {
  machines(): Machine[];
  addNow(
    target: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ target: string } | { error: string }>;
  renameNow(target: string, name: string): Promise<string | undefined>;
  removeNow(target: string): Promise<string | undefined>;
  disconnect(target: string): Promise<void>;
  retry(target: string): void;
  readTermDefaults(target: string): Promise<TermDefaults>;
  writeTermDefaults(
    target: string,
    startDir: string,
    shell: string,
  ): Promise<string | undefined>;
}

/** `kisui machine` の受け持ちの表を作る。 */
export function createMachineCommands(deps: {
  sessions: MachineOps;
  /** Machines の Dialog の行（workspaces/controller.ts の machineList） */
  machineList(): MachineRow[];
}): WindowCommandTable {
  const ops = deps.sessions;

  /** 引数 machine（CLI での名前か ssh の行き先）が指す行。無ければ断る。 */
  function resolve(args: Record<string, unknown>): MachineRow {
    const ref = argString(args, "machine").trim();
    const rows = deps.machineList();
    const list = ops.machines();
    // 名前（`--machine` と同じ）で探し、無ければ ssh の行き先で探す
    const target =
      machineTarget(list, ref) ??
      (ref !== "" && ref !== LOCAL
        ? rows.find((r) => r.target === ref)?.target
        : undefined);
    const row = rows.find((r) => r.target === target);
    if (row) return row;
    throw new WindowCommandError(
      T("machineCli.err.noMachine", {
        machine: ref,
        names: rows.map((r) => machineCliName(list, r.target)).join(", "),
      }),
    );
  }

  /** Dialog と同じ決まりで、行 row に action ができるかを確かめる。できなければ断る。 */
  function check(
    row: MachineRow,
    action: Exclude<MachineAction, "add" | "newTab" | "grant" | "grantEnd">,
  ): void {
    // hasWorkspace は newTab だけが見る
    const why = canDo(row, action, true);
    if (why) throw new WindowCommandError(why);
  }

  /** 書けなかった理由があれば断る。 */
  function fail(err: string | undefined): void {
    if (err !== undefined) throw new WindowCommandError(err);
  }

  return {
    "machine.list": {
      run() {
        const list = ops.machines();
        const machines: MachineInfo[] = deps.machineList().map((r) => ({
          name: machineCliName(list, r.target),
          ...(r.target === LOCAL ? {} : { ssh: r.target }),
          connected: r.health === "up",
          status: r.status,
          terminalTabs: r.terminalTabs,
          ...(r.fixed ? { fixed: true as const } : {}),
        }));
        return { machines };
      },
    },
    "machine.add": {
      async run(args, caller) {
        const ssh = argString(args, "ssh");
        const name = argOptionalString(args, "name") ?? "";
        const r = await ops.addNow(ssh, name, caller.signal);
        if ("error" in r) throw new WindowCommandError(r.error);
        return { name: machineCliName(ops.machines(), r.target) };
      },
    },
    "machine.rename": {
      async run(args) {
        const row = resolve(args);
        const name = argString(args, "name");
        check(row, "rename");
        fail(await ops.renameNow(row.target, name));
        return { name: machineCliName(ops.machines(), row.target) };
      },
    },
    "machine.remove": {
      async run(args) {
        const row = resolve(args);
        check(row, "remove");
        fail(await ops.removeNow(row.target));
        return {};
      },
    },
    "machine.disconnect": {
      async run(args) {
        const row = resolve(args);
        check(row, "disconnect");
        await ops.disconnect(row.target);
        return {};
      },
    },
    "machine.reconnect": {
      run(args) {
        const row = resolve(args);
        check(row, "reconnect");
        ops.retry(row.target);
        return {};
      },
    },
    "machine.terminal": {
      async run(args) {
        const row = resolve(args);
        const startDir = argOptionalString(args, "startDir");
        const shell = argOptionalString(args, "shell");
        const unsetStartDir = argFlag(args, "unsetStartDir");
        const unsetShell = argFlag(args, "unsetShell");
        const now = await ops.readTermDefaults(row.target);
        const change =
          startDir !== undefined ||
          shell !== undefined ||
          unsetStartDir ||
          unsetShell;
        if (change) {
          if (
            (startDir !== undefined && unsetStartDir) ||
            (shell !== undefined && unsetShell)
          )
            throw new WindowCommandError(T("machineCli.err.setAndUnset"));
          check(row, "terminal");
          // 付けなかった項目は、今の値のまま
          fail(
            await ops.writeTermDefaults(
              row.target,
              unsetStartDir ? "" : (startDir ?? now.startDir ?? ""),
              unsetShell ? "" : (shell ?? now.shell ?? ""),
            ),
          );
        }
        const d = change ? await ops.readTermDefaults(row.target) : now;
        const out: TerminalInfo = {};
        if (d.startDir) out.startDir = d.startDir;
        if (d.shell) out.shell = d.shell;
        return out;
      },
    },
  };
}
