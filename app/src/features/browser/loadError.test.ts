import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { en } from "../../i18n/en.ts";
import { ja } from "../../i18n/ja.ts";
import {
  isCertReason,
  reasonKey,
  toLoadError,
  type LoadReason,
} from "./loadError.ts";

const REASONS: LoadReason[] = [
  "cert-untrusted",
  "cert-expired",
  "cert-not-yet-valid",
  "cert-name",
  "cert-other",
  "host-not-found",
  "refused",
  "timed-out",
  "offline",
  "lost",
  "other",
];

describe("reasonKey", () => {
  it("どの理由にも、日本語と英語の文がある", () => {
    for (const r of REASONS) {
      const k = reasonKey(r);
      assert.ok(en[k], `en ${r}`);
      assert.ok(ja[k], `ja ${r}`);
    }
  });
  it("知らない分類は「そのほか」の文", () => {
    assert.equal(reasonKey("brand-new"), reasonKey("other"));
    assert.equal(reasonKey("toString"), reasonKey("other"));
  });
});

describe("isCertReason", () => {
  it("証明書の失敗だけ true", () => {
    assert.equal(isCertReason("cert-untrusted"), true);
    assert.equal(isCertReason("cert-name"), true);
    assert.equal(isCertReason("refused"), false);
  });
});

describe("toLoadError", () => {
  it("知らせの URL・理由・説明を持つ", () => {
    assert.deepEqual(
      toLoadError(
        { url: "https://a.test/", reason: "cert-expired", detail: "x" },
        "https://b.test/",
      ),
      { url: "https://a.test/", reason: "cert-expired", detail: "x" },
    );
  });
  it("URL が空ならタブの URL、知らない理由は other", () => {
    assert.deepEqual(
      toLoadError({ url: "", reason: "zzz", detail: "" }, "https://b.test/"),
      { url: "https://b.test/", reason: "other", detail: "" },
    );
  });
});
