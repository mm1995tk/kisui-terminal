import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  focusWorkspaceAndTerminal,
  type WorkspaceRef,
} from "./focusWorkspaceAndTerminal.ts";

function setup(onFocus: (set: (f: WorkspaceRef) => void) => void) {
  let current: WorkspaceRef | undefined = { target: "local", id: "a" };
  const calls: string[] = [];
  const deps = {
    focusWorkspace: async (target: string, id: string) => {
      calls.push(`focus ${target}/${id}`);
      onFocus((f) => (current = f));
    },
    current: () => current,
    focusTerminal: () => calls.push("terminal"),
  };
  return { deps, calls };
}

describe("ワークスペースを開いたあとのフォーカス（#151）", () => {
  it("移れたら、そのワークスペースのペインにキーを向ける", async () => {
    const { deps, calls } = setup((set) => set({ target: "local", id: "b" }));
    await focusWorkspaceAndTerminal(deps, "local", "b");
    assert.deepEqual(calls, ["focus local/b", "terminal"]);
  });
  it("戻る（A → B → A）ときも、戻った先のペインにキーを向ける", async () => {
    let at: WorkspaceRef = { target: "local", id: "a" };
    const calls: string[] = [];
    const deps = {
      focusWorkspace: async (target: string, id: string) => {
        at = { target, id };
      },
      current: () => at,
      focusTerminal: () => calls.push(`terminal ${at.id}`),
    };
    await focusWorkspaceAndTerminal(deps, "local", "b");
    await focusWorkspaceAndTerminal(deps, "local", "a");
    assert.deepEqual(calls, ["terminal b", "terminal a"]);
  });
  it("あとの押下に上書きされて、GUI のフォーカスが頼んだ先でないときは向けない", async () => {
    const { deps, calls } = setup(() => {});
    await focusWorkspaceAndTerminal(deps, "local", "b");
    assert.deepEqual(calls, ["focus local/b"]);
  });
  it("focusWorkspace が例外を投げても、向けずにそのまま返す", async () => {
    const calls: string[] = [];
    const deps = {
      focusWorkspace: async () => {
        throw new Error("no");
      },
      current: () => ({ target: "local", id: "a" }),
      focusTerminal: () => calls.push("terminal"),
    };
    await assert.rejects(focusWorkspaceAndTerminal(deps, "local", "b"));
    assert.deepEqual(calls, []);
  });
});
