import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, RpcError } from "../rpc/message.ts";
import { renameErrorText } from "./renameError.ts";

const invalid = (message: string) =>
  new RpcError({ code: ErrorCode.InvalidParams, message });

describe("renameErrorText", () => {
  it("知っている理由は日本語にする", () => {
    assert.equal(
      renameErrorText(invalid("the name is too long (at most 100 characters)")),
      "名前が長すぎます（100 文字まで）",
    );
    assert.equal(
      renameErrorText(invalid("the name has a control character")),
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
