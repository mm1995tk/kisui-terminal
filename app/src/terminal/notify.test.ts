import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TerminalNotification } from "coneko-term";

import { shouldNotify, toOsNotification } from "./notify.ts";

const base = { windowFocused: true, cellVisible: true, pageVisible: true };

describe("shouldNotify", () => {
  it("always は常に出す", () => {
    assert.equal(shouldNotify("always", base), true);
  });
  it("unfocused は窓が前に無いときだけ", () => {
    assert.equal(shouldNotify("unfocused", base), false);
    assert.equal(
      shouldNotify("unfocused", { ...base, windowFocused: false }),
      true,
    );
  });
  it("invisible は欄か窓が見えていないときだけ", () => {
    assert.equal(shouldNotify("invisible", base), false);
    assert.equal(
      shouldNotify("invisible", { ...base, cellVisible: false }),
      true,
    );
    assert.equal(
      shouldNotify("invisible", { ...base, pageVisible: false }),
      true,
    );
  });
});

describe("toOsNotification", () => {
  const n = (title: string, body: string) =>
    ({ title, body }) as TerminalNotification;
  it("題名と本文を渡す", () => {
    assert.deepEqual(toOsNotification(n("a", "b")), { title: "a", body: "b" });
  });
  it("本文だけなら題名にする", () => {
    assert.deepEqual(toOsNotification(n("", "Hello")), {
      title: "Hello",
      body: undefined,
    });
  });
});
