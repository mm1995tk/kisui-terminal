import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copyAndNotify } from "./copiedNotice.ts";

describe("copyAndNotify", () => {
  it("書けたら知らせる", async () => {
    let n = 0;
    await copyAndNotify(
      async () => true,
      () => n++,
    );
    assert.equal(n, 1);
  });

  it("書けなかったら知らせない", async () => {
    let n = 0;
    await copyAndNotify(
      async () => false,
      () => n++,
    );
    assert.equal(n, 0);
  });
});
