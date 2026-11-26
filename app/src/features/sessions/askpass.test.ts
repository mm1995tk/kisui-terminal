import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { askpassMachine } from "./askpass.ts";
import type { Machine } from "./machines.ts";

const machines: Machine[] = [
  { target: "user@web1.example", name: "本番" },
  { target: "build" },
];
const colors = { "user@web1.example": "#8fb4ff", build: "#e5b567" };

describe("ssh の質問の窓に出すマシン（askpass.ts）", () => {
  it("名前を付けたマシンは、サイドバーに出る名前と ssh の行き先の両方を出す", () => {
    assert.deepEqual(askpassMachine(machines, colors, "user@web1.example"), {
      label: "本番",
      target: "user@web1.example",
      color: "#8fb4ff",
    });
  });

  it("名前を付けていないマシンは、ssh の行き先を名前として 1 回だけ出す", () => {
    assert.deepEqual(askpassMachine(machines, colors, "build"), {
      label: "build",
      color: "#e5b567",
    });
  });

  it("一覧に無い行き先（足すためにつないでいる最中のマシン）は、行き先を名前にし、色は付けない", () => {
    assert.deepEqual(askpassMachine(machines, colors, "new-host"), {
      label: "new-host",
    });
  });

  it("質問ごとに、その質問の行き先のマシンを出す（ほかのマシンの名前にならない）", () => {
    assert.equal(askpassMachine(machines, colors, "build").label, "build");
    assert.equal(
      askpassMachine(machines, colors, "user@web1.example").label,
      "本番",
    );
  });
});
