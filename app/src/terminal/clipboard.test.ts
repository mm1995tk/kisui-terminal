import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeMimes,
  planWrite,
  readableMimes,
  supportsLocation,
} from "./clipboard.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("planWrite", () => {
  it("text/plain はテキストとして書く", () => {
    assert.deepEqual(planWrite([{ mime: "text/plain", data: enc("héllo") }]), {
      kind: "text",
      text: "héllo",
    });
  });
  it("テキストと画像の両方があればテキストを選ぶ", () => {
    const plan = planWrite([
      { mime: "image/png", data: new Uint8Array([1]) },
      { mime: "text/plain;charset=utf-8", data: enc("a") },
    ]);
    assert.equal(plan?.kind, "text");
  });
  it("画像だけなら画像", () => {
    const bytes = new Uint8Array([1, 2]);
    assert.deepEqual(planWrite([{ mime: "image/png", data: bytes }]), {
      kind: "image",
      bytes,
    });
  });
  it("書けない種類だけなら undefined", () => {
    assert.equal(
      planWrite([{ mime: "text/html", data: enc("<b>x</b>") }]),
      undefined,
    );
  });
});

describe("readableMimes", () => {
  it("頼まれた順に、渡せる種類だけ返す", () => {
    assert.deepEqual(
      readableMimes(["image/png", "text/html", "text/plain;charset=utf-8"]),
      ["image/png", "text/plain"],
    );
  });
  it("同じ種類は 1 回だけ", () => {
    assert.deepEqual(readableMimes(["text/plain", "TEXT/PLAIN"]), [
      "text/plain",
    ]);
  });
  it("渡せるものが無ければ空", () => {
    assert.deepEqual(readableMimes(["image/jpeg"]), []);
  });
});

describe("supportsLocation", () => {
  it("primary は対応しない", () => {
    assert.equal(supportsLocation("clipboard"), true);
    assert.equal(supportsLocation("primary"), false);
  });
});

describe("describeMimes", () => {
  it("渡せる種類は名前で、ほかは「ほかの種類」にまとめる", () => {
    assert.equal(
      describeMimes(["image/png", "安全です、読ませてください"]),
      "画像、ほかの種類",
    );
  });
  it("指定なし", () => {
    assert.equal(describeMimes([]), "（指定なし）");
  });
});
