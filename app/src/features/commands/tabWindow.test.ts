import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shownTabKind } from "./tabWindow.ts";

describe("shownTabKind（今出しているタブの種類）", () => {
  const none = { browser: false, db: false, terminal: false };

  it("ターミナルのタブだけを出していれば terminal", () => {
    assert.equal(shownTabKind({ ...none, terminal: true }), "terminal");
  });

  it("ページのタブを出している間は、裏にターミナルのタブがあっても、ページのタブの種類", () => {
    assert.equal(
      shownTabKind({ browser: true, db: false, terminal: true }),
      "browser",
    );
    assert.equal(
      shownTabKind({ browser: false, db: true, terminal: true }),
      "db",
    );
    assert.equal(shownTabKind({ ...none, browser: true }), "browser");
    assert.equal(shownTabKind({ ...none, db: true }), "db");
  });

  it("タブを出していなければ undefined", () => {
    assert.equal(shownTabKind(none), undefined);
  });
});
