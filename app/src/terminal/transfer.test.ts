import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync, inflateSync } from "node:zlib";

import type { FileTransferEvent } from "coneko-term";

import {
  createTransfer,
  formatBytes,
  readInfo,
  type Listing,
  type TransferOs,
  type TransferReplies,
} from "./transfer.ts";
import type { TransferInfo } from "./transferPrompt.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

type Call = [string, ...unknown[]];

function fakeTerm() {
  const calls: Call[] = [];
  const term: TransferReplies = {
    replyFileTransferOk: (...a) => void calls.push(["ok", ...a]),
    replyFileTransferStarted: (...a) => void calls.push(["started", ...a]),
    replyFileTransferProgress: (...a) => void calls.push(["progress", ...a]),
    replyFileTransferError: (id, code, o) =>
      void calls.push(["error", id, code, o?.fileId]),
    refuseFileTransfer: (...a) => void calls.push(["refuse", ...a]),
    replyFileTransferCanceled: (...a) => void calls.push(["canceled", ...a]),
    replyFileTransferListing: (id, e) =>
      void calls.push(["listing", id, e.entryId, e.name]),
    replyFileTransferData: (id, f, d, end) =>
      void calls.push(["data", id, f, dec(d), end ?? false]),
  };
  return { term, calls };
}

function fakeOs(opts: { list?: Listing; files?: Record<string, string> } = {}) {
  const log: string[] = [];
  const written = new Map<string, number[]>();
  const os: TransferOs = {
    dest: async () => "/home/u/Downloads",
    writeBegin: async (k) => (log.push(`begin ${k}`), "/home/u/Downloads"),
    writeOpen: async (_k, o) => {
      if (o.name === "exists") {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      log.push(`open ${o.name} ${o.directory ? "dir" : "file"} ${o.limit}`);
      return o.name;
    },
    writeChunk: async (_k, f, b) => {
      const cur = written.get(f) ?? [];
      cur.push(...b);
      written.set(f, cur);
      return cur.length;
    },
    writeEnd: async (_k, f) => written.get(f)?.length ?? 0,
    writeClose: async (_k, keep) => void log.push(`wclose ${keep}`),
    readList: async (_k, req) => {
      log.push(`list ${req.map((r) => r.name).join(",")}`);
      return (
        opts.list ?? { entries: [], errors: [], home: "/home/u", totalSize: 0 }
      );
    },
    readApprove: async () => void log.push("approve"),
    readOpen: async (_k, id) => (log.push(`ropen ${id}`), 0),
    readNext: async (_k, id) => {
      const rest = opts.files?.[id] ?? "";
      opts.files = { ...opts.files, [id]: "" };
      return enc(rest);
    },
    readClose: async () => void log.push("rclose"),
  };
  return { os, log, written };
}

function fakeAsk(answer: boolean | "wait") {
  const asked: TransferInfo[] = [];
  let cancelled = 0;
  let release!: (b: boolean) => void;
  const ask = (info: TransferInfo) => {
    asked.push(info);
    const allowed =
      answer === "wait"
        ? new Promise<boolean>((r) => (release = r))
        : Promise.resolve(answer);
    return {
      allowed,
      cancel: () => {
        cancelled++;
        release?.(false);
      },
    };
  };
  return {
    ask,
    asked,
    cancelled: () => cancelled,
    release: (b: boolean) => release(b),
  };
}

const send = (id = "s1"): FileTransferEvent => ({
  type: "send",
  id,
  bypass: null,
  quiet: 0,
  paths: null,
});
const file = (
  over: Partial<Extract<FileTransferEvent, { type: "file" }>>,
): FileTransferEvent => ({
  type: "file",
  id: "s1",
  fileId: "f1",
  name: "a.txt",
  fileType: "regular",
  compression: "none",
  transmission: "simple",
  mtime: null,
  permissions: null,
  size: null,
  parent: null,
  ...over,
});
const data = (
  d: Uint8Array,
  end: boolean,
  id = "s1",
  fileId = "f1",
): FileTransferEvent => ({
  type: "data",
  id,
  fileId,
  data: d,
  end,
});

describe("write (プログラム → 手元)", () => {
  it("聞いて許されたら書き、書き終えたら OK を返す", async () => {
    const { term, calls } = fakeTerm();
    const { os, log, written } = fakeOs();
    const { ask, asked } = fakeAsk(true);
    const t = createTransfer(term, os, ask, "v1");
    t.handle(send());
    t.handle(file({ size: 5 }));
    t.handle(data(enc("hel"), false));
    t.handle(data(enc("lo"), true));
    t.handle({ type: "finish", id: "s1" });
    await settle();
    assert.deepEqual(asked, [
      { direction: "write", destination: "/home/u/Downloads" },
    ]);
    assert.deepEqual(calls, [
      ["ok", "s1"],
      ["started", "s1", "f1", false],
      ["progress", "s1", "f1", 3],
      ["ok", "s1", { fileId: "f1", size: 5 }],
    ]);
    assert.equal(dec(Uint8Array.from(written.get("f1")!)), "hello");
    assert.deepEqual(log, ["begin v1:s1", "open a.txt file 5", "wclose true"]);
  });

  it("断られたら、何も書かずに断りで答え、あとの命令は捨てる", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs();
    const t = createTransfer(term, os, fakeAsk(false).ask, "v1");
    t.handle(send());
    t.handle(file({}));
    t.handle(data(enc("x"), true));
    await settle();
    assert.deepEqual(calls, [["refuse", "s1"]]);
    assert.ok(!log.some((l) => l.startsWith("open") || l.startsWith("begin")));
  });

  it("パスワードによる確認の省略（bypass）があっても聞く", async () => {
    const { term } = fakeTerm();
    const { os } = fakeOs();
    const a = fakeAsk(false);
    const t = createTransfer(term, os, a.ask, "v1");
    t.handle({ ...send(), bypass: "sha256:abc" } as FileTransferEvent);
    await settle();
    assert.equal(a.asked.length, 1);
  });

  it("zlib のデータは展開して書く", async () => {
    const { term, calls } = fakeTerm();
    const { os, written } = fakeOs();
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    const body = "compressed text ".repeat(100);
    const z = deflateSync(enc(body));
    t.handle(send());
    t.handle(file({ compression: "zlib", size: body.length }));
    t.handle(data(z.subarray(0, 10), false));
    t.handle(data(z.subarray(10), true));
    await settle();
    assert.equal(dec(Uint8Array.from(written.get("f1")!)), body);
    assert.deepEqual(calls.at(-1), [
      "ok",
      "s1",
      { fileId: "f1", size: body.length },
    ]);
  });

  it("リンクは作らず、EPERM で答える", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs();
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    t.handle(send());
    t.handle(file({ fileType: "symlink", fileId: "l1" }));
    t.handle(file({ fileType: "link", fileId: "l2" }));
    await settle();
    assert.deepEqual(calls.slice(1), [
      ["error", "s1", "EPERM", "l1"],
      ["error", "s1", "EPERM", "l2"],
    ]);
    assert.ok(!log.some((l) => l.startsWith("open")));
  });

  it("書けなかったファイルのデータは捨て、記号名をそのまま返す", async () => {
    const { term, calls } = fakeTerm();
    const { os, written } = fakeOs();
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    t.handle(send());
    t.handle(file({ name: "exists" }));
    t.handle(data(enc("x"), true));
    await settle();
    assert.deepEqual(calls.slice(1), [["error", "s1", "EEXIST", "f1"]]);
    assert.equal(written.size, 0);
  });

  it("ディレクトリは OK で答える", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs();
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    t.handle(send());
    t.handle(file({ fileType: "directory", name: "d", fileId: "d1" }));
    await settle();
    assert.deepEqual(calls.slice(1), [["ok", "s1", { fileId: "d1" }]]);
    assert.ok(log.includes("open d dir 2147483648"));
  });

  it("聞いている最中の取り消しは、窓を取り下げて CANCELED で答える", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs();
    const a = fakeAsk("wait");
    const t = createTransfer(term, os, a.ask, "v1");
    t.handle(send());
    await settle();
    t.handle({ type: "cancel", id: "s1" });
    await settle();
    assert.equal(a.cancelled(), 1);
    assert.deepEqual(calls, [["canceled", "s1"]]);
    assert.ok(log.includes("wclose false"));
  });

  it("欄を閉じると、聞いているものを断り、書き終えたファイルは残して途中のものだけ消す", async () => {
    const { term } = fakeTerm();
    const { os, log } = fakeOs();
    const a = fakeAsk("wait");
    const t = createTransfer(term, os, a.ask, "v1");
    t.handle(send());
    await settle();
    t.dispose();
    await settle();
    assert.equal(a.cancelled(), 1);
    assert.ok(log.includes("wclose true"));
  });
});

const listing: Listing = {
  entries: [
    {
      requestId: "f1",
      entryId: "e1",
      name: "/home/u/a.txt",
      fileType: "regular",
      mtime: "1700000000000000000",
      permissions: 0o644,
      size: 5,
      parent: null,
      data: null,
    },
  ],
  errors: [{ requestId: "f2", code: "ENOENT", message: "missing" }],
  home: "/home/u",
  totalSize: 5,
};
const receive = (paths: number | null = 2): FileTransferEvent => ({
  type: "receive",
  id: "r1",
  bypass: null,
  quiet: 0,
  paths,
});
const req = (fileId: string, name: string, over = {}): FileTransferEvent =>
  file({ id: "r1", fileId, name, ...over });

describe("read (手元 → プログラム)", () => {
  it("頼みのパスがそろってから、一覧を見せて聞き、許されたら並べて返す", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs({ list: listing, files: { e1: "hello" } });
    const a = fakeAsk(true);
    const t = createTransfer(term, os, a.ask, "v1");
    t.handle(receive());
    t.handle(req("f1", "~/a.txt"));
    await settle();
    assert.equal(a.asked.length, 0);
    t.handle(req("f2", "~/nope"));
    await settle();
    assert.deepEqual(a.asked, [
      {
        direction: "read",
        items: [{ path: "/home/u/a.txt", kind: "regular", size: 5 }],
        more: 0,
        files: 1,
        totalSize: 5,
      },
    ]);
    assert.deepEqual(calls, [
      ["error", "r1", "ENOENT", "f2"],
      ["listing", "r1", "e1", "/home/u/a.txt"],
      ["ok", "r1", { name: "/home/u" }],
    ]);
    // 並べたあとの頼みでデータを送る
    t.handle(req("e1", "/home/u/a.txt"));
    await settle();
    assert.deepEqual(calls.slice(-2), [
      ["data", "r1", "e1", "hello", false],
      ["data", "r1", "e1", "", true],
    ]);
    assert.ok(log.indexOf("approve") < log.indexOf("ropen e1"));
  });

  it("断られたら、一覧を返さず断りで答える（読まない）", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs({ list: listing });
    const t = createTransfer(term, os, fakeAsk(false).ask, "v1");
    t.handle(receive(1));
    t.handle(req("f1", "~/a.txt"));
    await settle();
    assert.deepEqual(calls, [["refuse", "r1"]]);
    assert.ok(!log.includes("approve"));
  });

  it("許した一覧に無いファイルは読まない", async () => {
    const { term, calls } = fakeTerm();
    const { os, log } = fakeOs({ list: listing });
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    t.handle(receive(1));
    t.handle(req("f1", "~/a.txt"));
    await settle();
    t.handle(req("e9", "/home/u/.ssh/id_ed25519"));
    await settle();
    assert.deepEqual(calls.at(-1), ["error", "r1", "EPERM", "e9"]);
    assert.ok(!log.includes("ropen e9"));
  });

  it("rsync の頼みは EINVAL で断る", async () => {
    const { term, calls } = fakeTerm();
    const { os } = fakeOs({ list: listing });
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    t.handle(receive(1));
    t.handle(req("f1", "~/a.txt"));
    await settle();
    t.handle(req("e1", "x", { transmission: "rsync" }));
    await settle();
    assert.deepEqual(calls.at(-1), ["error", "r1", "EINVAL", "e1"]);
  });

  it("zlib を頼まれたら圧縮して送る", async () => {
    const { term, calls } = fakeTerm();
    const out: Uint8Array[] = [];
    term.replyFileTransferData = (_i, _f, d) => void out.push(d);
    const { os } = fakeOs({
      list: listing,
      files: { e1: "hello hello hello" },
    });
    const t = createTransfer(term, os, fakeAsk(true).ask, "v1");
    t.handle(receive(1));
    t.handle(req("f1", "~/a.txt"));
    await settle();
    t.handle(req("e1", "x", { compression: "zlib" }));
    await settle();
    const all = Buffer.concat(out);
    assert.equal(inflateSync(all).toString(), "hello hello hello");
    assert.ok(calls.length > 0);
  });

  it("パスの数が分からない・多すぎる頼みは断る", async () => {
    const { term, calls } = fakeTerm();
    const { os } = fakeOs();
    const a = fakeAsk(true);
    const t = createTransfer(term, os, a.ask, "v1");
    t.handle(receive(null));
    t.handle({ ...receive(1000), id: "r2" } as FileTransferEvent);
    await settle();
    assert.deepEqual(calls, [
      ["refuse", "r1"],
      ["refuse", "r2"],
    ]);
    assert.equal(a.asked.length, 0);
  });
});

describe("セッションの数", () => {
  it("上限を超える始まりは断る", async () => {
    const { term, calls } = fakeTerm();
    const { os } = fakeOs();
    const t = createTransfer(term, os, fakeAsk("wait").ask, "v1");
    for (const id of ["a", "b", "c", "d", "e"]) t.handle(send(id));
    await settle();
    assert.deepEqual(calls, [["refuse", "e"]]);
  });
});

describe("helpers", () => {
  it("formatBytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KiB");
    assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MiB");
    assert.equal(formatBytes(300 * 1024 ** 3), "300 GiB");
  });
  it("readInfo は見せる数を絞り、残りを数える", () => {
    const many: Listing = {
      ...listing,
      entries: Array.from({ length: 15 }, (_, i) => ({
        ...listing.entries[0]!,
        entryId: `e${i}`,
      })),
      totalSize: 75,
    };
    const info = readInfo(many);
    assert.equal(info.direction, "read");
    if (info.direction === "read") {
      assert.equal(info.items.length, 12);
      assert.equal(info.more, 3);
      assert.equal(info.files, 15);
    }
  });
});

describe("見つからないだけの頼み", () => {
  it("聞かず、エラーの中身も返さず、断りだけで答える", async () => {
    const { term, calls } = fakeTerm();
    const empty: Listing = {
      entries: [],
      errors: [{ requestId: "f1", code: "EACCES", message: "(os error 13)" }],
      home: "/home/u",
      totalSize: 0,
    };
    const { os } = fakeOs({ list: empty });
    const a = fakeAsk(true);
    const t = createTransfer(term, os, a.ask, "v1");
    t.handle(receive(1));
    t.handle(req("f1", "/root/secret"));
    await settle();
    assert.equal(a.asked.length, 0);
    assert.deepEqual(calls, [["refuse", "r1"]]);
  });
});
