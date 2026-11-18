// タブを足すマシンを選ぶ窓（#272）を、本物の Solid の <Show> で確かめる。
// 窓（workspaces/WorkspaceDialogs.tsx）は JSX なので node --test では描けない。ここでは同じ形（when={pickingFor()}、
// onChoose で setPickingFor(null) のあとに newTerminalTab(gid, t)）を JSX を使わずに作る。
// WorkspaceDialogs.tsx の <Show> が keyed であることは ui/windowShow.test.ts が確かめる。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// node では solid-js がサーバー用（反応しない作り）に解決されるので、ブラウザー用を名指しで読む。
// このパスには型の宣言が無いので、型は solid-js のものを当てる
const solid: typeof import("solid-js") = await import(
  String("solid-js/dist/solid.js")
);

/**
 * 窓を描いて、MachinePicker が受け取る onChoose を返す。
 * keyed なら今の作り（子が受け取るのは値）、keyed でなければ直す前の作り（子が受け取るのはアクセサ）。
 */
function openPicker(
  keyed: boolean,
  newTerminalTab: (gid: string, target: string) => void,
): (target: string) => void {
  return solid.createRoot(() => {
    const [pickingFor, setPickingFor] = solid.createSignal<string | null>("g1");
    let onChoose: ((target: string) => void) | undefined;
    const children = (gid: string | (() => string)) => {
      onChoose = (t) => {
        setPickingFor(null);
        newTerminalTab(typeof gid === "string" ? gid : gid(), t);
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

describe("タブを足すマシンを選ぶ窓", () => {
  it("<Show keyed> の窓でマシンを選ぶと、そのワークスペースで newTerminalTab が呼ばれる", () => {
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
