import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HelloResult } from "../rpc/protocol.ts";
import {
  canConnect,
  describeClient,
  stateLabel,
  statusLine,
} from "./status.ts";

const hello = { shj: { version: "0.7.0" } } as HelloResult;

describe("statusLine", () => {
  it("つながっていれば行を出さず、版はツールチップに出す", () => {
    assert.deepEqual(statusLine({ kind: "connected", hello }), {
      text: "",
      title: "つながっています（shj 0.7.0）",
    });
  });

  it("つなぎ直している最中は何回目かを出す（モックの「再接続中（2 回目）」）", () => {
    assert.deepEqual(
      statusLine({ kind: "reconnecting", attempt: 2, max: 5, reason: "EOF" }),
      { text: "再接続中（2 回目）", title: "EOF" },
    );
  });

  it("待ち時間中は残りの秒数（読み上げる text とは分ける）と、今すぐつなぐボタン", () => {
    assert.deepEqual(
      statusLine(
        {
          kind: "reconnecting",
          attempt: 3,
          max: 5,
          retryAt: 10_500,
          reason: "EOF",
        },
        8_000,
      ),
      {
        text: "再接続中（3 回目）",
        title: "EOF",
        retry: "now",
        countdown: "3 秒後",
      },
    );
    assert.equal(
      statusLine({ kind: "connecting", attempt: 2, max: 5, retryAt: 0 }, 0)
        .retry,
      "now",
    );
  });

  it("使い切った・引き継がれたあとは、つなぎ直すボタン", () => {
    assert.deepEqual(statusLine({ kind: "failed", message: "boom" }), {
      text: "つながりません",
      title: "boom",
      retry: "again",
    });
    assert.equal(statusLine({ kind: "superseded" }).retry, "again");
  });

  it("初めての試みは回数を出さない", () => {
    assert.equal(
      statusLine({ kind: "connecting", attempt: 1, max: 5 }).text,
      "つないでいます…",
    );
    assert.equal(
      statusLine({ kind: "connecting", attempt: 2, max: 5 }).text,
      "つないでいます…（2 回目）",
    );
  });
});

describe("stateLabel と canConnect", () => {
  it("まだつないでいなければ空で、押せる", () => {
    assert.equal(stateLabel(undefined), "");
    assert.equal(canConnect(undefined), true);
  });

  it("つながっている・つないでいる最中は押せない", () => {
    assert.equal(stateLabel({ kind: "connected", hello }), "接続中");
    assert.equal(canConnect({ kind: "connected", hello }), false);
    assert.equal(
      canConnect({ kind: "reconnecting", attempt: 1, max: 5, reason: "" }),
      false,
    );
  });

  it("使い切った・引き継がれたあとは押せる（つなぎ直す）", () => {
    assert.equal(canConnect({ kind: "failed", message: "" }), true);
    assert.equal(canConnect({ kind: "superseded" }), true);
  });
});

describe("describeClient", () => {
  it("名前と版をつなげ、時刻が読めなければ省く", () => {
    assert.equal(
      describeClient({
        client: {
          name: "shijimi-editor-gui",
          version: "0.7.0",
          kind: "native",
        },
        connectedAt: "nope",
      }),
      "shijimi-editor-gui 0.7.0",
    );
  });
});
