import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TerminalNotification } from "coneko-term";

import {
  notificationSupportFor,
  shouldNotify,
  toOsNotification,
} from "./notify.ts";

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

describe("notificationSupportFor", () => {
  it("Linux と Windows は押された・閉じられたを返せる", () => {
    for (const ua of [
      "Mozilla/5.0 (X11; Linux x86_64)",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ]) {
      const s = notificationSupportFor(ua);
      assert.deepEqual(s.actions, ["focus", "report"]);
      assert.equal(s.closeReport, true);
    }
  });
  it("macOS は閉じられたを返せない", () => {
    const s = notificationSupportFor("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
    assert.deepEqual(s.actions, ["focus", "report"]);
    assert.equal(s.closeReport, false);
  });
});
