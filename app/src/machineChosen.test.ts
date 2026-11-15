import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { machineChosen } from "./machineChosen.ts";

// node では solid-js がサーバー用（反応しない作り）に解決されるので、ブラウザー用を名指しで読む。
// このパスには型の宣言が無いので、型は solid-js のものを当てる
const solid: typeof import("solid-js") = await import(
  String("solid-js/dist/solid.js")
);

/**
 * App.tsx の、タブを足すマシンを選ぶ窓と同じ形を、本物の <Show> で作る。
 * 窓を描いて、MachinePicker が受け取る onChoose を返す。
 * keyed なら今の作り（machineChosen）、keyed でなければ直す前の作り（閉じてからアクセサを読む）。
 */
function openPicker(
  keyed: boolean,
  newTab: (gid: string, target: string) => void,
): (target: string) => void {
  return solid.createRoot(() => {
    const [pickingFor, setPickingFor] = solid.createSignal<string | null>("g1");
    let onChoose: ((target: string) => void) | undefined;
    const children = (gid: string | (() => string)) => {
      onChoose =
        typeof gid === "string"
          ? machineChosen(gid, () => setPickingFor(null), newTab)
          : (t) => {
              setPickingFor(null);
              newTab(gid(), t);
            };
      return null;
    };
    const view = solid.Show({
      get when() {
        return pickingFor();
      },
      keyed,
      children,
    } as unknown as Parameters<
      typeof solid.Show
    >[0]) as unknown as () => unknown;
    view();
    assert.ok(onChoose, "窓が描かれていない");
    return onChoose;
  });
}

describe("machineChosen", () => {
  it("窓を閉じたあとでも、選んだマシンでそのワークスペースにタブを足す", () => {
    const calls: string[] = [];
    machineChosen(
      "g1",
      () => calls.push("close"),
      (gid, t) => calls.push(`${gid}/${t}`),
    )("m1");
    assert.deepEqual(calls, ["close", "g1/m1"]);
  });

  it("<Show keyed> の窓でマシンを選ぶと、newTerminalTab が呼ばれる（#272）", () => {
    const calls: string[] = [];
    const choose = openPicker(true, (gid, t) => calls.push(`${gid}/${t}`));
    choose("m1");
    assert.deepEqual(calls, ["g1/m1"]);
  });

  it("keyed でない <Show> で、窓を閉じたあとにアクセサを読むと例外になる（直す前の形）", () => {
    const calls: string[] = [];
    const choose = openPicker(false, (gid, t) => calls.push(`${gid}/${t}`));
    assert.throws(() => choose("m1"), /Stale read from <Show>/);
    assert.deepEqual(calls, []);
  });
});
