import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, RpcError } from "../rpc/message.ts";
import type { TermInfo } from "../rpc/protocol.ts";
import {
  decodeBase64,
  encodeBase64,
  EXITED_NOTICE,
  TermLink,
  type TermPort,
  type TermSink,
} from "./link.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s: string) => encodeBase64(enc.encode(s));

/** 返事を手で返す偽の shj。term.list は alive に出したターミナルを返す。 */
function fakePort(opts: { terms?: TermInfo[] } = {}) {
  const calls: { method: string; params: any }[] = [];
  const acks: { termId: string; seq: number }[] = [];
  const handlers: Record<string, (params: any) => unknown> = {
    "term.list": () => ({ terms: opts.terms ?? [alive("t1")] }),
    "term.attach": () => ({ seq: 0, snapshot: "", cols: 80, rows: 24 }),
    "term.input": () => ({}),
    "term.resize": () => ({}),
    "term.close": () => ({}),
    "term.restart": () => ({ pid: 2, cwd: "/w" }),
  };
  const port: TermPort = {
    async request(method, params) {
      calls.push({ method, params });
      const r = handlers[method]!(params);
      if (r instanceof Error) throw r;
      return r as never;
    },
    ackTerm(termId, seq) {
      acks.push({ termId, seq });
    },
  };
  return { port, calls, acks, handlers };
}

/** 書いたものを溜める偽の画面。done は手で呼ぶ（coneko-term の書き終わり）。 */
function fakeSink() {
  const out: string[] = [];
  const pending: (() => void)[] = [];
  let resets = 0;
  const sink: TermSink = {
    write(data, done) {
      out.push(dec.decode(data));
      pending.push(done);
    },
    notice(text) {
      out.push(text);
    },
    reset() {
      resets++;
      out.length = 0;
    },
  };
  return {
    sink,
    out,
    text: () => out.join(""),
    flush: () => pending.splice(0).forEach((f) => f()),
    resets: () => resets,
  };
}

/** term.list に出るターミナル。 */
function alive(termId: string, isAlive = true): TermInfo {
  return {
    termId,
    pid: 1,
    cwd: "/w",
    workspaceId: "w1",
    primary: false,
    title: "",
    cols: 80,
    rows: 24,
    alive: isAlive,
  };
}

// 返事を待つ await がいくつか続くので、何回か回す
const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function output(termId: string, seq: number, s: string) {
  return {
    method: "term.output" as const,
    params: { termId, seq, data: b64(s) },
  };
}

const exitOf = (termId: string) => ({
  method: "term.exit" as const,
  params: { termId, code: 0 },
});

describe("TermLink", () => {
  it("つないだら画面の状態を取り直し、出力を書いて、書き終えた分を ack する", async () => {
    const f = fakePort();
    f.handlers["term.attach"] = () => ({
      seq: 2,
      snapshot: b64("$ "),
      cols: 80,
      rows: 24,
    });
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["term.attach", "term.list"],
    );
    assert.deepEqual(f.calls[0]!.params, { termId: "t1" });
    assert.equal(s.text(), "$ ");

    link.handle(output("t1", 7, "hello"));
    assert.equal(s.text(), "$ hello");
    assert.deepEqual(f.acks, []); // 書き終えるまで返さない
    s.flush();
    assert.deepEqual(f.acks, [{ termId: "t1", seq: 7 }]);
  });

  it("取り直した分と重なる出力は重なりを捨て、別のターミナルの出力は無視する", async () => {
    const f = fakePort();
    f.handlers["term.attach"] = () => ({
      seq: 4,
      snapshot: b64("abcd"),
      cols: 80,
      rows: 24,
    });
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    link.handle(output("t1", 3, "abc")); // 全部取り直し済み
    link.handle(output("t1", 6, "cdef")); // cd は取り直し済み
    link.handle(output("t9", 10, "zzz"));
    assert.equal(s.text(), "abcdef");
  });

  it("seq が飛んだら、term.attach で画面の状態を取り直し、reset してから書く。返事を待つ間の出力は、書き出しのあとの分だけをつなぐ", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    link.handle(output("t1", 3, "abc"));
    f.handlers["term.attach"] = () => ({
      seq: 20,
      snapshot: b64("[rest]"),
      cols: 80,
      rows: 24,
    });
    const resets = s.resets();
    link.handle(output("t1", 15, "xyz")); // 3..12 が捨てられた
    link.handle(output("t1", 20, "late!")); // attach の返事待ちの間。書き出し（seq 20）に入っている
    link.handle(output("t1", 25, "next!")); // 書き出しのあとの分
    await tick();
    assert.deepEqual(f.calls.at(-1), {
      method: "term.attach",
      params: { termId: "t1" },
    });
    assert.equal(s.resets(), resets + 1);
    assert.equal(s.text(), "[rest]next!");
    link.handle(output("t1", 27, "ok"));
    assert.equal(s.text(), "[rest]next!ok");
  });

  it("つないだターミナルの大きさが画面と違えば合わせる", async () => {
    const f = fakePort({ terms: [{ ...alive("t3"), cols: 50 }] });
    const s = fakeSink();
    const link = new TermLink(f.port, "t3");
    link.resize(120, 40);
    link.bind(s.sink);
    await tick();
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["term.resize", "term.attach", "term.list", "term.resize"],
    );
    assert.deepEqual(f.calls[3]!.params, { termId: "t3", cols: 120, rows: 40 });
  });

  it("キー入力を base64 にして送り、大きさが変わったら term.resize を送る", async () => {
    const f = fakePort();
    const link = new TermLink(f.port, "t1");
    link.bind(fakeSink().sink);
    await tick();
    link.input(enc.encode("ls\r"));
    link.resize(90, 20);
    link.resize(90, 20);
    await tick();
    assert.deepEqual(f.calls.slice(2), [
      { method: "term.input", params: { termId: "t1", data: b64("ls\r") } },
      { method: "term.resize", params: { termId: "t1", cols: 90, rows: 20 } },
    ]);
  });

  it("つなぎ直したら画面の状態を取り直す", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    link.handle(output("t1", 2, "ab"));
    f.calls.length = 0;
    link.reconnected();
    await tick();
    assert.deepEqual(f.calls, [
      { method: "term.attach", params: { termId: "t1" } },
      { method: "term.list", params: {} },
    ]);
  });

  it("分割したターミナルのシェルが終わったら、残りを取ってから onExit で知らせる（知らせは書かない）", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    let exits = 0;
    link.onExit = () => exits++;
    link.bind(s.sink);
    await tick();
    f.handlers["term.attach"] = () => ({
      seq: 5,
      snapshot: b64("exit\n"),
      cols: 80,
      rows: 24,
    });
    link.handle(exitOf("t1"));
    await tick();
    assert.equal(s.text(), "exit\n");
    assert.equal(exits, 1);
    // 分割したターミナルは Enter で作り直さない
    f.calls.length = 0;
    link.input(enc.encode("\r"));
    await tick();
    assert.deepEqual(f.calls, []);
  });

  it("プライマリターミナルのシェルが終わっても欄を閉じず、知らせを出して Enter で term.restart する", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1", undefined, { primary: true });
    let exits = 0;
    link.onExit = () => exits++;
    link.bind(s.sink);
    await tick();
    f.handlers["term.attach"] = () => ({
      seq: 5,
      snapshot: b64("exit\n"),
      cols: 80,
      rows: 24,
    });
    link.handle(exitOf("t1"));
    await tick();
    assert.equal(s.text(), "exit\n" + EXITED_NOTICE);
    assert.equal(exits, 0, "欄を閉じさせない");

    f.calls.length = 0;
    link.input(enc.encode("a")); // Enter 以外は何もしない
    await tick();
    assert.deepEqual(f.calls, []);

    f.handlers["term.attach"] = () => ({
      seq: 8,
      snapshot: b64("new\n"),
      cols: 80,
      rows: 24,
    });
    link.input(enc.encode("\r"));
    link.input(enc.encode("\r")); // 続けて押しても 1 回だけ
    await tick();
    assert.deepEqual(f.calls, [
      { method: "term.restart", params: { termId: "t1" } },
      { method: "term.attach", params: { termId: "t1" } },
    ]);
    assert.equal(link.id, "t1");
    assert.equal(link.hasExited, false);
    assert.equal(s.text(), "new\n"); // 取り直した画面に置き換わる（終わった知らせは消える）

    // 作り直したシェルの入力は、また送る
    link.input(enc.encode("ls"));
    await tick();
    assert.equal(
      (f.calls as { method: string }[]).at(-1)!.method,
      "term.input",
    );
  });

  it("term.restart が断られたら知らせ、また Enter で試せる", async () => {
    const f = fakePort();
    const errors: string[] = [];
    const link = new TermLink(f.port, "t1", (m) => errors.push(m), {
      primary: true,
    });
    link.bind(fakeSink().sink);
    await tick();
    link.handle(exitOf("t1"));
    await tick();
    f.handlers["term.restart"] = () =>
      new RpcError({ code: ErrorCode.Busy, message: "still running" });
    link.input(enc.encode("\r"));
    await tick();
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /term\.restart/);
    assert.equal(link.hasExited, true);
    f.calls.length = 0;
    f.handlers["term.restart"] = () => ({ pid: 3, cwd: "/w" });
    link.input(enc.encode("\r"));
    await tick();
    assert.equal(f.calls[0]!.method, "term.restart");
  });

  it("外したら出力を書かず ack もしない。また付けたら画面の状態を取り直す", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    link.handle(output("t1", 2, "ab"));
    link.unbind();
    s.flush(); // 外す前に書いた分の書き終わり
    link.handle(output("t1", 4, "cd"));
    assert.deepEqual(f.acks, []);

    const s2 = fakeSink();
    f.calls.length = 0;
    link.bind(s2.sink);
    await tick();
    assert.deepEqual(f.calls, [
      { method: "term.attach", params: { termId: "t1" } },
      { method: "term.list", params: {} },
    ]);
  });

  it("取り直した分を画面が書き終える前に欠けが続いても、取り直しは書き終えてから 1 回だけ", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    s.flush();
    let attaches = 0;
    f.handlers["term.attach"] = () => {
      attaches++;
      return { seq: attaches * 100, snapshot: b64("R"), cols: 80, rows: 24 };
    };
    link.handle(output("t1", 10, "x")); // 0..9 が欠けた
    await tick();
    assert.equal(attaches, 1);
    // 書き終える前に、また欠ける
    link.handle(output("t1", 150, "y"));
    link.handle(output("t1", 180, "z"));
    await tick();
    assert.equal(attaches, 1);
    s.flush(); // 取り直した分を書き終えた
    await tick();
    assert.equal(attaches, 2);
    assert.deepEqual(f.calls.at(-1)!.params, { termId: "t1" });
    s.flush();
    await tick();
    assert.equal(attaches, 2); // 欠けが無ければもう取り直さない
  });

  it("取り直しの返事を待つ間のキー入力も送る", async () => {
    const f = fakePort();
    const link = new TermLink(f.port, "t1");
    link.bind(fakeSink().sink);
    await tick();
    let answer!: () => void;
    f.handlers["term.attach"] = () =>
      new Promise((r) => {
        answer = () => r({ seq: 20, snapshot: "", cols: 80, rows: 24 });
      });
    link.handle(output("t1", 20, "x")); // 欠けたので取り直す
    link.input(enc.encode("\x03"));
    await tick();
    assert.deepEqual(f.calls.at(-1), {
      method: "term.input",
      params: { termId: "t1", data: b64("\x03") },
    });
    answer();
  });

  it("外している間に終わったシェルは、付け直したときに知らせて Enter で作り直せる（プライマリ）", async () => {
    const f = fakePort();
    const link = new TermLink(f.port, "t1", undefined, { primary: true });
    link.bind(fakeSink().sink);
    await tick();
    link.unbind();
    link.handle(exitOf("t1")); // 外しているので届かない
    f.handlers["term.list"] = () => ({ terms: [alive("t1", false)] });
    const s = fakeSink();
    link.bind(s.sink);
    await tick();
    assert.ok(s.text().endsWith(EXITED_NOTICE));
    assert.equal(s.text().split(EXITED_NOTICE).length - 1, 1); // 1 回だけ
    f.calls.length = 0;
    link.input(enc.encode("\r"));
    await tick();
    assert.equal(f.calls[0]!.method, "term.restart");
  });

  it("term.input が not_found なら、シェルが終わったものとして扱う", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1", undefined, { primary: true });
    link.bind(s.sink);
    await tick();
    f.handlers["term.input"] = () =>
      new RpcError({
        code: ErrorCode.NotFound,
        message: "terminal has exited",
      });
    link.input(enc.encode("a"));
    await tick();
    assert.ok(s.text().endsWith(EXITED_NOTICE));
  });

  it("shj にターミナルが無ければ（shj が作り直された）、分割したターミナルは欄を閉じさせる", async () => {
    const f = fakePort();
    const link = new TermLink(f.port, "t1");
    let exits = 0;
    link.onExit = () => exits++;
    link.bind(fakeSink().sink);
    await tick();
    f.handlers["term.attach"] = () =>
      new RpcError({ code: ErrorCode.NotFound, message: "no such terminal" });
    link.reconnected();
    await tick();
    assert.equal(exits, 1);
  });

  it("終わったプライマリをつなぎ直すと、画面は書き出しに置き換わるので、終わった知らせをもう一度出す", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1", undefined, { primary: true });
    link.bind(s.sink);
    await tick();
    f.handlers["term.attach"] = () => ({
      seq: 5,
      snapshot: b64("exit\n"),
      cols: 80,
      rows: 24,
    });
    link.handle(exitOf("t1"));
    await tick();
    f.handlers["term.list"] = () => ({ terms: [alive("t1", false)] });
    link.reconnected();
    await tick();
    assert.equal(s.text(), "exit\n" + EXITED_NOTICE);
  });

  it("書き出しの返事を待つ間に届いた出力が、書き出しより前の分だけなら書かない", async () => {
    const f = fakePort();
    const s = fakeSink();
    const link = new TermLink(f.port, "t1");
    link.bind(s.sink);
    await tick();
    let answer!: () => void;
    f.handlers["term.attach"] = () =>
      new Promise((r) => {
        answer = () => r({ seq: 10, snapshot: b64("S"), cols: 80, rows: 24 });
      });
    link.reconnected();
    link.handle(output("t1", 4, "old")); // 書き出しに入っている
    link.handle(output("t1", 10, "olde")); // これも
    answer();
    await tick();
    assert.equal(s.text(), "S");
  });
});

describe("base64", () => {
  it("どのバイトも行き来できる", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.deepEqual(decodeBase64(encodeBase64(all)), all);
    const big = new Uint8Array(100_000).fill(0x79);
    assert.equal(decodeBase64(encodeBase64(big)).length, 100_000);
  });
});
