import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { T } from "../../i18n/index.ts";
import type { BrowserTab } from "./tabs.ts";
import {
  browserWindowMarks,
  browserWindowRows,
  browserWindowTitle,
  selectedRow,
  stepRow,
} from "./window.ts";

const tab = (over: Partial<BrowserTab> = {}): BrowserTab => ({
  id: "b1",
  target: "@local",
  workspace: "w1",
  url: "https://example.com/",
  title: "Example",
  ...over,
});

/** 行の字と、できない理由（できる行は ""）。 */
const why = (t: BrowserTab) =>
  Object.fromEntries(browserWindowRows(t).map((r) => [r.key, r.why ?? ""]));

describe("ブラウザのタブの窓の行（#459）", () => {
  it("行は o のグループの字を引き継ぎ、上から 戻る・進む・読み込み直す・止める・URL・コピー・外部・ログイン・検索・足す・一覧・開発者ツール", () => {
    assert.deepEqual(
      browserWindowRows(tab()).map((r) => r.key),
      ["h", "l", "r", "c", "u", "y", "e", "s", "/", "b", "B", "i"],
    );
  });

  it("ふつうのページ：履歴が無ければ戻る・進むができず、読み込み中でなければ止められない。ほかはできる", () => {
    const w = why(tab());
    assert.equal(w.h, T("browserWindow.why.noBack"));
    assert.equal(w.l, T("browserWindow.why.noForward"));
    assert.equal(w.c, T("browserWindow.why.notLoading"));
    for (const k of ["r", "u", "y", "e", "s", "/", "b", "B", "i"])
      assert.equal(w[k], "", k);
  });

  it("履歴があれば戻る・進むができ、読み込み中なら止められる", () => {
    const w = why(
      tab({
        history: { back: true, forward: true },
        loading: { progress: 40 },
      }),
    );
    assert.equal(w.h, "");
    assert.equal(w.l, "");
    assert.equal(w.c, "");
  });

  it("新しいタブのページ：URL（検索窓へ）とブックマークの一覧のほかは、まだページが無い", () => {
    const w = why(tab({ url: "", title: "" }));
    assert.equal(w.u, "");
    assert.equal(w.B, "");
    for (const k of ["h", "l", "r", "y", "e", "s", "/", "b", "i"])
      assert.equal(w[k], T("browserWindow.why.noPage"), k);
  });

  it("シークレットのタブは、外部ブラウザでログインできない（理由は今の文と同じ）", () => {
    assert.equal(
      why(tab({ incognito: true })).s,
      T("cannot.browser.login.incognito"),
    );
  });
});

describe("選ぶ行", () => {
  const rows = browserWindowRows(tab());

  it("初めは、上から見て最初のできる行（履歴が無ければ読み込み直す）", () => {
    assert.equal(selectedRow(rows, undefined), "reload");
    assert.equal(
      selectedRow(
        browserWindowRows(tab({ history: { back: true, forward: false } })),
        undefined,
      ),
      "back",
    );
    // 新しいタブのページは URL
    assert.equal(
      selectedRow(browserWindowRows(tab({ url: "" })), undefined),
      "url",
    );
  });

  it("選んだ行を覚える（できない行も、字で選んだなら）", () => {
    assert.equal(selectedRow(rows, "stop"), "stop");
  });

  it("j k は、できない行を飛ばし、端で止まる", () => {
    assert.equal(stepRow(rows, "reload", 1), "url");
    assert.equal(stepRow(rows, "url", -1), "reload");
    assert.equal(stepRow(rows, "reload", -1), "reload");
    assert.equal(stepRow(rows, "devtools", 1), "devtools");
  });
});

describe("窓の上の印と見出し", () => {
  it("シークレット・読み込み中・読み込めなかった・通信を記録中・表示の大きさ", () => {
    assert.deepEqual(browserWindowMarks(tab()), []);
    assert.deepEqual(
      browserWindowMarks(
        tab({
          incognito: true,
          loading: { progress: 42.4 },
          loadError: {
            url: "https://x.example/",
            reason: "refused",
            detail: "",
          },
          proxy: { scope: "s", port: 1 },
          zoom: 1.25,
        }),
      ),
      [
        { text: T("browserWindow.incognito") },
        { text: T("browserWindow.loading", { percent: 42 }) },
        { text: T("browserWindow.loadFailed"), alert: true },
        { text: T("browserWindow.proxy") },
        { text: T("browserWindow.zoom", { percent: 125 }) },
      ],
    );
  });

  it("見出しはページの題。無ければ URL、新しいタブのページは「新しいタブ」", () => {
    assert.equal(browserWindowTitle(tab()), "Example");
    assert.equal(
      browserWindowTitle(tab({ title: "" })),
      "https://example.com/",
    );
    assert.equal(
      browserWindowTitle(tab({ url: "", title: "" })),
      T("browserWindow.newTabTitle"),
    );
  });
});
