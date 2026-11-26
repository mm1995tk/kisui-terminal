import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOCAL } from "./shell.ts";
import {
  createParams,
  shellParam,
  shellProblem,
  startDirProblem,
  termDefaultsByTarget,
} from "./termDefaults.ts";

describe("マシンのターミナルの始め方（termDefaults）", () => {
  it("設定から、つなぎ先ごとの分を取り出す（「ローカル」は [server]、リモートは [[gui.machines]] の項目）", () => {
    assert.deepEqual(
      termDefaultsByTarget({
        localTerminal: { startDir: "~/src", shell: null },
        machines: [
          { ssh: "dev", name: "d", startDir: "~/work", shell: "/bin/fish" },
          { ssh: "build", shell: "~/bin/zsh" },
          { ssh: "plain", startDir: null, shell: null },
        ],
      }),
      {
        [LOCAL]: { startDir: "~/src" },
        dev: { startDir: "~/work", shell: "/bin/fish" },
        build: { shell: "~/bin/zsh" },
        plain: {},
      },
    );
    assert.deepEqual(termDefaultsByTarget({ machines: [] }), { [LOCAL]: {} });
  });

  it("start_dir は、絶対パスか ~・~/… だけ（空は「書かない」）", () => {
    for (const ok of ["", "/", "/srv/app", "~", "~/work", "/a b/c"])
      assert.equal(startDirProblem(ok), undefined, ok);
    for (const bad of [
      "work",
      "./work",
      "~user/x",
      "$HOME/x",
      "/a\nb",
      "C:\\x",
    ])
      assert.notEqual(startDirProblem(bad), undefined, bad);
  });

  it("shell は、ファイルの絶対パスか ~/… だけ（名前だけ・フォルダの形・制御文字は書けない）", () => {
    for (const ok of ["", "/bin/zsh", "~/.nix-profile/bin/fish"])
      assert.equal(shellProblem(ok), undefined, ok);
    for (const bad of ["fish", "~", "/bin/", "~fish", "/bin/sh\t-l"])
      assert.notEqual(shellProblem(bad), undefined, bad);
  });

  it("書いていない項目も、空の文字列で渡す（serve が、前に渡したシェルを覚えたままにしない）", () => {
    assert.deepEqual(createParams({ startDir: "~/w", shell: "/bin/zsh" }), {
      startDir: "~/w",
      shell: "/bin/zsh",
    });
    assert.deepEqual(createParams({}), { startDir: "", shell: "" });
    assert.deepEqual(shellParam({ startDir: "~/w" }), { shell: "" });
    assert.deepEqual(shellParam({ shell: "/bin/zsh" }), { shell: "/bin/zsh" });
  });
});
