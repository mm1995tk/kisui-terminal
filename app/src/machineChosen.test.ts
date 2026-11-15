import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { machineChosen } from "./machineChosen.ts";

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
});
