// 殻がページの中で動かす favicon のスクリプト（app/src-tauri/src/browser_favicon.js。#237）の、候補の順。
// スクリプトは殻が関数の本体として動かす（モジュールではない）ので、同じように関数の本体にして candidates を取り出す。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface Link {
  rel: string;
  sizes: string;
  type: string;
  href: string;
}

const src = readFileSync(
  new URL("../../src-tauri/src/browser_favicon.js", import.meta.url),
  "utf8",
);
const candidates = new Function(`${src}\nreturn candidates;`)() as (
  links: Link[],
  base: string,
) => string[];

const link = (rel: string, href: string, more: Partial<Link> = {}): Link => ({
  rel,
  href,
  sizes: "",
  type: "",
  ...more,
});
const BASE = "https://a.example/dir/page";

describe("favicon の候補（#237）", () => {
  it("32×32 か SVG の icon を先に、残りの icon を後に書いたものから、apple-touch-icon、/favicon.ico の順", () => {
    const got = candidates(
      [
        link("icon", "/16.png", { sizes: "16x16" }),
        link("apple-touch-icon", "/touch.png"),
        link("shortcut icon", "/old.ico"),
        link("icon", "/32.png", { sizes: "32x32" }),
        link("icon", "/i.svg", { type: "image/svg+xml" }),
        link("stylesheet", "/s.css"),
      ],
      BASE,
    );
    assert.deepEqual(got, [
      "https://a.example/32.png",
      "https://a.example/i.svg",
      "https://a.example/old.ico",
      "https://a.example/16.png",
      "https://a.example/touch.png",
      "https://a.example/favicon.ico",
    ]);
  });

  it("相対の URL はページから解く。http・https・data: だけ。重なりは除く", () => {
    const got = candidates(
      [
        link("icon", "img/a.png"),
        link("icon", "javascript:alert(1)"),
        link("icon", "file:///etc/passwd"),
        link("icon", "data:image/png;base64,AAAA"),
        link("ICON", "/favicon.ico"),
      ],
      BASE,
    );
    assert.deepEqual(got, [
      "https://a.example/favicon.ico",
      "data:image/png;base64,AAAA",
      "https://a.example/dir/img/a.png",
    ]);
  });

  it("<link> が無ければ /favicon.ico だけ", () => {
    assert.deepEqual(candidates([], BASE), ["https://a.example/favicon.ico"]);
  });
});
