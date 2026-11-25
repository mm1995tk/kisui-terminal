# AGENTS.md

Instructions for coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md) and the "Development" section of the [README](README.md).

## Project

- kisui-terminal is a terminal-centered workspace (a desktop app, Tauri) that works closely with shijimi-editor. `app/` is the window: the web UI (Solid + TypeScript) in `app/src/` and the Tauri shell (Rust) in `app/src-tauri/`. `kisui` (Go) is its server: `cmd/kisui` (`kisui serve` / `kisui attach`), `server/`, `attach/`, `rpc/`, `config/`. `internal/` is kisui's own copy of what it shares with `shj` and the small parts it keeps for itself. `extension/` is the Firefox extension that hands a passkey login back to the built-in browser (`docs/browser-extension.md`).
- Call it **kisui-terminal** in user-facing text (README, release notes). The editor is **shijimi-editor** (its binary is `shj`); do not shorten it to "shijimi".
- kisui-terminal imports no Go code of shijimi-editor, and shijimi-editor none of kisui-terminal. They meet through the agreement in `docs/protocol.md`; the types are copied on both sides (`internal/ctl` here, `core/ctl` there). Keep it that way (a test, `cmd/kisui/deps_test.go`, fails otherwise). Add a feature to the agreement by adding a field or a request; see `docs/protocol.md` for when the version goes up.
- The `shj` kisui-terminal ships is the one shijimi-editor released (the flake input `shijimi-editor`, or the Release that `packaging/fetch-shj.sh` downloads). This repository does not build `shj`.

## Before you finish a change

Run these from the Nix devShell (`nix develop`, or `direnv allow`):

```sh
go test ./...        # must pass
npm test             # the web UI
npm run test:extension  # the browser extension (extension/)
cargo test           # the Tauri shell
nix fmt              # must leave no changes (nixfmt / gofmt / taplo / rustfmt / prettier)
nix flake check      # what CI runs: formatting, go test ./..., the build (cargo test), npm test and the extension
```

Run every command from the root of the repository. `go.mod`, `package.json` and `Cargo.toml` (a workspace whose member is `app/src-tauri`) are all there. Do not `cd` into `app/`.

## Rules that CI or tests enforce

- **Dependencies**: after changing `go.mod`, run `gomod2nix` and commit the updated `gomod2nix.toml`.
  After changing `package-lock.json`, update `npmDepsHash` in `packaging/nix/kisui-terminal.nix` (set it to `lib.fakeHash`, run `nix build .#kisui-terminal`, and copy the hash it prints).
  After adding or changing a `uses:` in `.github/workflows/`, run `gh actions-lock` (install it with `gh extension install github/gh-actions-lock`) and commit the updated `.github/workflows/actions.lock`.
- **Layout of the window's code** (`app/src/`): `ui/` is display and input, `features/` is the state, operations and rules of each feature, `infrastructure/` is the code that talks to the outside (the Tauri shell, `kisui serve`, storage). `features/` must not import `ui/`, `@tauri-apps/*`, `infrastructure/tauri/` or `infrastructure/storage/`; a feature declares the interface it needs and `app/src/index.tsx` passes the real one. Read `docs/design/frontend-structure.md` before you add or move a file. `app/src/architecture.test.ts` fails when a dependency points the wrong way, and `app/src/ui/main-window/cssOrder.test.ts` fails when the order of the CSS changes.
- **UI strings of kisui**: add a key to both `internal/i18n/en.go` and `internal/i18n/ja.go`. A test fails when the two tables differ.
- **UI strings of the window** (`app/src/`): never write a sentence in the code. Add a key to both `app/src/i18n/en.ts` and `app/src/i18n/ja.ts` and ask for it with `T("key", { name: value })` (`{name}` is a slot; both languages need the same slots). `app/src/i18n/i18n.test.ts` fails when the two tables differ. The language is `ui-language` in the local `config.toml` (`en` by default), read once at startup by `index.tsx`, so build a sentence when it is shown, not in a way that needs the language before startup. **Names of operations stay in English in the Japanese window** (buttons, menu items, the operations in the leader guide and in the `?` key lists, the key hints such as `select` / `cancel`, and the headings of dialogs and popups), so that the user and a coding agent point at an operation with the same word; only sentences (hints, notices, errors, confirmations, descriptions) are Japanese. A key is an operation name if the word names the operation. Keys under `leader.` and `place.` (except `place.*.lead`), `button.`, `treeMenu.`, `basic.`, `keys.col.` and `*.keys.*` are operation names by their prefix; add any other one to `OPERATION_NAME_KEYS` in `app/src/i18n/operationNames.ts`, and write the same English text in `ja.ts` (`i18n.test.ts` fails when they differ).
- **Keys while the IME is converting** (`app/src/`): never read `e.isComposing` or `e.keyCode` directly. Skip the keys of Japanese conversion with `isComposingKey(e)` from `app/src/features/commands/ime.ts` (on macOS, the `Enter` that confirms a conversion can come with `isComposing` false and `keyCode` 229). `app/src/features/commands/ime.test.ts` fails when a file reads them directly, or looks at `Enter` / `Escape` without calling `isComposingKey`.
- **`internal/emulator/emulator.wasm`**: after changing `emulator/` or `Cargo.lock`, rebuild it on x86_64-linux and commit it (`scripts/build-emulator.sh`, or the `emulator-wasm` artifact of the CI `check` run; see CONTRIBUTING.md). A wasm built on macOS or aarch64-linux does not match.
- **No import of shijimi-editor** (`cmd/kisui/deps_test.go`).
- **Mascot format**: the skill `agent-plugin/skills/make-mascot/SKILL.md` (the Claude Code / Codex plugin `kisui-mascot`) carries the `mascot.toml` format in its own text, because the repository is not there where it is installed. When you change the format in `docs/mascot.md` (scenes, keys, defaults, image rules), change the skill too.

## Conventions

- **Operations go in the leader tree.** When you add or change an operation, put it in the leader tree (Cmd+K on macOS, Ctrl+Shift+K elsewhere) in `docs/key-design.md`, and update `docs/keys.md`. The leader tree is kisui-terminal's own key space, so a key there cannot clash with a program in the terminal (the shell, `shj`). An operation that points at a place on the screen (dragging a border, clicking a URL in the terminal, dropping files from the OS) may be GUI-only, with no reason needed. Keep the default shortcuts (keys that skip the leader) few; users will be able to add shortcuts for the operations they use often in the config file (the mechanism is #199, not built yet). While the terminal has focus, do not take a shortcut that a program in it (the shell, `shj`) needs; check it against the table in `docs/key-design.md` first. Where the terminal does not have focus (the built-in browser page, the file tree, CHANGES, and so on), a shortcut does not clash with those programs, so you may put one there (for example, Cmd+R reloads while the built-in browser is shown). An operation that only works inside one area (the file tree, CHANGES, the video or image pane) is an area key: it goes in the `?` list of that area, not in the leader tree.
- `README.md` and `README.ja.md` describe the same things. When you change one, change the other.
- One pull request is one change. Describe what changed and why, and link the issue if there is one.
- Commit messages and pull request text may be in Japanese or English. The existing history is in Japanese.
- Features and behavior changes need an agreed issue first (see CONTRIBUTING.md). Bug fixes do not.
- A change to the agreement with `shj` (`docs/protocol.md`) needs a matching change in shijimi-editor; link the two pull requests.

## Releasing

- Before you release anything (run `release.yml` or `nightly.yml`, or open a pull request that changes the version), read [docs/releasing.md](docs/releasing.md) and follow it. This includes how to choose the version: while the version is 0.x, a release that adds user-visible features raises minor, not patch.
- A request such as "release it" does not override the procedure. If the request and the procedure disagree, for example on which commit to release or which part of the version to raise, tell the owner before releasing and ask which to follow.
