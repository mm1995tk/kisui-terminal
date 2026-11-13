# AGENTS.md

Instructions for coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md) and the "Development" section of the [README](README.md).

## Project

- kisui-terminal is a terminal-centered workspace (a desktop app, Tauri) that works closely with shijimi-editor. `app/` is the window: the web UI (Solid + TypeScript) in `app/src/` and the Tauri shell (Rust) in `app/src-tauri/`. `kisui` (Go) is its server: `cmd/kisui` (`kisui serve` / `kisui attach`), `server/`, `attach/`, `rpc/`, `config/`. `internal/` is kisui's own copy of what it shares with `shj` and the small parts it keeps for itself.
- Call it **kisui-terminal** in user-facing text (README, release notes). The editor is **shijimi-editor** (its binary is `shj`); do not shorten it to "shijimi".
- kisui-terminal imports no Go code of shijimi-editor, and shijimi-editor none of kisui-terminal. They meet through the agreement in `docs/protocol.md`; the types are copied on both sides (`internal/ctl` here, `core/ctl` there). Keep it that way (a test, `cmd/kisui/deps_test.go`, fails otherwise). Add a feature to the agreement by adding a field or a request; see `docs/protocol.md` for when the version goes up.
- The `shj` kisui-terminal ships is the one shijimi-editor released (the flake input `shijimi-editor`, or the Release that `packaging/fetch-shj.sh` downloads). This repository does not build `shj`.

## Before you finish a change

Run these from the Nix devShell (`nix develop`, or `direnv allow`):

```sh
go test ./...        # must pass
npm test             # the web UI
cargo test           # the Tauri shell
nix fmt              # must leave no changes (nixfmt / gofmt / taplo / rustfmt / prettier)
nix flake check      # what CI runs: formatting, go test ./..., the build (cargo test) and npm test
```

Run every command from the root of the repository. `go.mod`, `package.json` and `Cargo.toml` (a workspace whose member is `app/src-tauri`) are all there. Do not `cd` into `app/`.

## Rules that CI or tests enforce

- **Dependencies**: after changing `go.mod`, run `gomod2nix` and commit the updated `gomod2nix.toml`.
  After changing `package-lock.json`, update `npmDepsHash` in `packaging/nix/kisui-terminal.nix` (set it to `lib.fakeHash`, run `nix build .#kisui-terminal`, and copy the hash it prints).
  After adding or changing a `uses:` in `.github/workflows/`, run `gh actions-lock` (install it with `gh extension install github/gh-actions-lock`) and commit the updated `.github/workflows/actions.lock`.
- **UI strings of kisui**: add a key to both `internal/i18n/en.go` and `internal/i18n/ja.go`. A test fails when the two tables differ.
- **`internal/emulator/emulator.wasm`**: after changing `emulator/` or `Cargo.lock`, rebuild it on x86_64-linux and commit it (`scripts/build-emulator.sh`, or the `emulator-wasm` artifact of the CI `check` run; see CONTRIBUTING.md). A wasm built on macOS or aarch64-linux does not match.
- **No import of shijimi-editor** (`cmd/kisui/deps_test.go`).

## Conventions

- **Keys come with every operation.** The app is keyboard-first: the mouse is the escape hatch, not the main path. When you add or change an operation, give it a key, put it in the leader tree (Cmd+K on macOS, Ctrl+Shift+K elsewhere) in `docs/key-design.md`, and update `docs/keys.md`. If a GUI-only operation is better (scrolling, dropping files from the OS), say why in `docs/key-design.md`. Do not take a key that a program in the terminal (the shell, `shj`) needs; check it against the table in `docs/key-design.md` first. An operation that only works inside one area (the file tree, CHANGES, the video or image pane) is an area key instead: it goes in the `?` list of that area, not in the leader tree.
- `README.md` and `README.ja.md` describe the same things. When you change one, change the other.
- One pull request is one change. Describe what changed and why, and link the issue if there is one.
- Commit messages and pull request text may be in Japanese or English. The existing history is in Japanese.
- Features and behavior changes need an agreed issue first (see CONTRIBUTING.md). Bug fixes do not.
- A change to the agreement with `shj` (`docs/protocol.md`) needs a matching change in shijimi-editor; link the two pull requests.

## Releasing

- Before you release anything (run `release.yml` or `nightly.yml`, or open a pull request that changes the version), read [docs/releasing.md](docs/releasing.md) and follow it. This includes how to choose the version: while the version is 0.x, a release that adds user-visible features raises minor, not patch.
- A request such as "release it" does not override the procedure. If the request and the procedure disagree, for example on which commit to release or which part of the version to raise, tell the owner before releasing and ask which to follow.
