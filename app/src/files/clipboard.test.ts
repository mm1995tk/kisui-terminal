import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ClipboardLike, OsClipboard } from "./clipboard.ts";

function fakeClipboard(initial = "") {
  let text = initial;
  let allow = true;
  const cb: ClipboardLike = {
    writeText: async (t) => {
      if (!allow) throw new Error("NotAllowedError");
      text = t;
    },
    readText: async () => text,
  };
  return {
    cb,
    get text() {
      return text;
    },
    set allow(v: boolean) {
      allow = v;
    },
  };
}

describe("OsClipboard", () => {
  it("書けたら OS のクリップボードに入り、読むとそれが返る", async () => {
    const f = fakeClipboard("old");
    const c = new OsClipboard(() => f.cb);
    await c.write("new");
    assert.equal(f.text, "new");
    assert.equal(c.unwritten, undefined);
    assert.equal(await c.read(), "new");
  });

  it("断られたら覚えておき、flush で書き直す。覚えている間の貼り付けはその文字", async () => {
    const f = fakeClipboard("old");
    const errors: unknown[] = [];
    const c = new OsClipboard(
      () => f.cb,
      (e) => errors.push(e),
    );
    f.allow = false;
    await c.write("copied");
    assert.equal(f.text, "old");
    assert.equal(c.unwritten, "copied");
    assert.equal(errors.length, 1);
    assert.equal(await c.read(), "copied");

    f.allow = true;
    await c.flush();
    assert.equal(f.text, "copied");
    assert.equal(c.unwritten, undefined);
  });

  it("discard したら書き直さず、OS のクリップボードの内容を貼る", async () => {
    const f = fakeClipboard("old");
    const c = new OsClipboard(() => f.cb);
    f.allow = false;
    await c.write("copied");
    f.allow = true;
    // ウィンドウを離れている間に、ほかのアプリでコピーした
    c.discard();
    await f.cb.writeText("other");
    await c.flush();
    assert.equal(f.text, "other");
    assert.equal(c.unwritten, undefined);
    assert.equal(await c.read(), "other");
  });

  it("クリップボードが無ければ、読むと空", async () => {
    const c = new OsClipboard(() => undefined);
    assert.equal(await c.read(), "");
  });
});
