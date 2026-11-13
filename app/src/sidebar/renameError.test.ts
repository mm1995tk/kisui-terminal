import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, RpcError } from "../rpc/message.ts";
import { renameErrorText } from "./renameError.ts";

const invalid = (message: string, data?: unknown) =>
  new RpcError({ code: ErrorCode.InvalidParams, message, data });

describe("renameErrorText", () => {
  it("serve が data で教えた理由は日本語にする（上限は serve の値）", () => {
    assert.equal(
      renameErrorText(invalid("x", { reason: "too_long", max: 100 })),
      "名前が長すぎます（100 文字まで）",
    );
    assert.equal(
      renameErrorText(invalid("x", { reason: "control_character" })),
      "名前に改行などの制御文字は使えません",
    );
  });

  it("知らない理由と、RPC のエラーでないものはそのまま出す", () => {
    assert.match(renameErrorText(invalid("other")), /other/);
    assert.equal(
      renameErrorText(new Error("つながっていません")),
      "つながっていません",
    );
  });
});
