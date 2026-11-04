import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Status } from "../rpc/protocol.ts";
import {
  cmdlineText,
  modeLabel,
  statusLeft,
  statusRight,
  textCells,
  titleText,
} from "./bars.ts";

const status = (s: Partial<Status>): Status => ({
  mode: "NOR",
  style: "mode.normal",
  cursor: { line: 0, col: 0 },
  ...s,
});

describe("titleText", () => {
  it("フォルダを含むパスは、名前と右に出すパスに分ける", () => {
    assert.deepEqual(titleText({ text: "internal/ui/explorer.go" }), {
      name: "explorer.go",
      path: "internal/ui/explorer.go",
    });
  });

  it("ファイル名だけなら、右には出さない", () => {
    assert.deepEqual(titleText({ text: "main.go" }), {
      name: "main.go",
      path: "",
    });
    assert.deepEqual(titleText({ text: "" }), { name: "", path: "" });
  });
});

describe("状態行", () => {
  it("モードの欄に途中まで押されたキーを足す。モードが無ければ空", () => {
    assert.equal(modeLabel(status({})), "NOR");
    assert.equal(modeLabel(status({ pending: "space" })), "NOR space");
    assert.equal(modeLabel(status({ mode: "" })), "");
  });

  it("左は TUI と同じ順に並べ、診断はどちらかがあれば両方出す", () => {
    assert.deepEqual(
      statusLeft(
        status({
          branch: "main",
          pane: "ターミナル",
          errors: 0,
          warnings: 2,
          suggestions: "提案 1",
          msg: "保存しました",
        }),
      ),
      [
        { text: "⎇ main" },
        { text: "ターミナル" },
        { text: "● 0", style: "diag.error" },
        { text: "▲ 2", style: "diag.warn" },
        { text: "提案 1" },
        { text: "保存しました", style: "editor.fg" },
      ],
    );
    assert.deepEqual(statusLeft(status({})), []);
  });

  it("エラーのメッセージはエラーの色にする", () => {
    assert.deepEqual(statusLeft(status({ msg: "失敗", msgErr: true })), [
      { text: "失敗", style: "error" },
    ]);
  });

  it("右は空の項目を飛ばす", () => {
    assert.deepEqual(
      statusRight(
        status({ position: "3:5", language: "Go", version: "v0.7.0" }),
      ),
      [{ text: "3:5" }, { text: "Go" }, { text: "v0.7.0" }],
    );
  });
});

describe("cmdlineText", () => {
  it("入るときは全部出し、カーソルの文字を分ける", () => {
    assert.deepEqual(cmdlineText({ prefix: ":", text: "wq", cursor: 1 }, 10), {
      before: "w",
      at: "q",
      after: "",
    });
  });

  it("カーソルが行の終わりなら、空白に置く", () => {
    assert.deepEqual(cmdlineText({ prefix: ":", text: "wq", cursor: 2 }, 10), {
      before: "wq",
      at: " ",
      after: "",
    });
  });

  it("はみ出すときは、カーソルが見えるように前を削る", () => {
    const c = { prefix: "/", text: "abcdefghij", cursor: 10 };
    assert.deepEqual(cmdlineText(c, 4), { before: "hij", at: " ", after: "" });
    assert.deepEqual(cmdlineText({ ...c, cursor: 0 }, 4), {
      before: "",
      at: "a",
      after: "bcd",
    });
  });

  it("全角の文字は 2 マス目で数える", () => {
    const r = cmdlineText({ prefix: "/", text: "日本語", cursor: 3 }, 5);
    assert.deepEqual(r, { before: "本語", at: " ", after: "" });
    assert.equal(textCells(r.before + r.at), 5);
  });

  it("カーソルの位置が範囲の外でも落ちない", () => {
    assert.deepEqual(cmdlineText({ prefix: ":", text: "ab", cursor: 9 }, 10), {
      before: "ab",
      at: " ",
      after: "",
    });
  });
});
