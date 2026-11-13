import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";

import { init, Terminal } from "coneko-term";

import type { WritePlan } from "./clipboard.ts";
import {
  connectClipboard,
  type AskClipboardRead,
  type ClipboardOs,
} from "./clipboardBridge.ts";

// 本物の coneko-term（WASM）にエスケープシーケンスを流し、OS の口まで届くかを見る
before(async () => {
  const entry = createRequire(import.meta.url).resolve("coneko-term");
  const wasm = new URL("wasm/coneko_term_wasm_bg.wasm", `file://${entry}`);
  await init(readFileSync(wasm));
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = new TextDecoder();
const b64 = (s: string) => Buffer.from(s).toString("base64");
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(opts: { allow?: boolean; clipboard?: string } = {}) {
  const term = new Terminal();
  const out: string[] = [];
  term.onData((d) => out.push(dec.decode(d)));
  const writes: WritePlan[] = [];
  const asked: string[][] = [];
  const os: ClipboardOs = {
    write: async (plan) => void writes.push(plan),
    available: async () => ["text/plain"],
    readFirst: async (mimes) =>
      opts.clipboard !== undefined && mimes.includes("text/plain")
        ? { mime: "text/plain", data: enc(opts.clipboard) }
        : undefined,
  };
  const ask: AskClipboardRead = (mimes) => {
    asked.push(mimes);
    return { allowed: Promise.resolve(opts.allow ?? false), cancel: () => {} };
  };
  const dispose = connectClipboard(term, os, ask);
  const write = async (s: string) => {
    await new Promise<void>((r) => term.write(s, r));
    await tick();
  };
  return { term, out, writes, asked, dispose, write };
}

describe("connectClipboard と OSC 52", () => {
  it("OSC 52 の書き込みは、テキストとして OS のクリップボードに書く", async () => {
    const s = setup();
    await s.write(`\x1b]52;c;${b64("選んだ文字")}\x07`);
    assert.deepEqual(s.writes, [{ kind: "text", text: "選んだ文字" }]);
    // OSC 52 には書き込みの返事が無い
    assert.deepEqual(s.out, []);
    s.dispose();
    s.term.dispose();
  });

  it("primary selection（p）への OSC 52 の書き込みは、OS に書かない", async () => {
    const s = setup();
    await s.write(`\x1b]52;p;${b64("x")}\x1b\\`);
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.out, []);
    s.dispose();
    s.term.dispose();
  });

  it("OSC 52 の読み取りは、許すかを聞き、許されたら OSC 52 の形で中身を返す", async () => {
    const s = setup({ allow: true, clipboard: "hi" });
    await s.write("\x1b]52;c;?\x07");
    assert.deepEqual(s.asked, [["text/plain"]]);
    assert.deepEqual(s.out, [`\x1b]52;c;${b64("hi")}\x07`]);
    s.dispose();
    s.term.dispose();
  });

  it("OSC 52 の読み取りを断ったら、中身の無い返事にする", async () => {
    const s = setup({ allow: false, clipboard: "secret" });
    await s.write("\x1b]52;c;?\x1b\\");
    assert.deepEqual(s.asked, [["text/plain"]]);
    assert.deepEqual(s.out, ["\x1b]52;c;\x1b\\"]);
    s.dispose();
    s.term.dispose();
  });

  it("primary selection の OSC 52 の読み取りは、聞かずに中身の無い返事にする", async () => {
    const s = setup({ allow: true, clipboard: "secret" });
    await s.write("\x1b]52;p;?\x07");
    assert.deepEqual(s.asked, []);
    assert.deepEqual(s.out, ["\x1b]52;p;\x07"]);
    s.dispose();
    s.term.dispose();
  });
});

describe("connectClipboard と OSC 5522", () => {
  it("OSC 5522 の書き込みも、今までどおり OS に書いて DONE と答える", async () => {
    const s = setup();
    await s.write(
      `\x1b]5522;type=write:id=w\x1b\\` +
        `\x1b]5522;type=wdata:mime=${b64("text/plain")};${b64("abc")}\x1b\\` +
        `\x1b]5522;type=wdata\x1b\\`,
    );
    assert.deepEqual(s.writes, [{ kind: "text", text: "abc" }]);
    assert.deepEqual(s.out, ["\x1b]5522;type=write:status=DONE:id=w\x1b\\"]);
    s.dispose();
    s.term.dispose();
  });
});
