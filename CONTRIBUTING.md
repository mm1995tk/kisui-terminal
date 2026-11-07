# Contributing

Thank you for your interest. kisui-terminal is a small project, so the rules are short.

## Issues first

Features and behavior changes need an agreed issue before a pull request: open one and describe the problem and the change you have in mind. Bug fixes do not need an issue; a pull request with the fix is enough.

## Development

```sh
nix develop            # or: direnv allow
npm ci
go test ./...          # kisui
npm test               # the web UI
cargo test             # the Tauri shell
nix fmt                # format everything
nix flake check        # every check CI runs
```

Everything runs from the root of the repository. To run the app, build a kisui and start Tauri with `SHIJIMI_KISUI` pointing at it, or `nix run .#dev` outside the devShell (see the README).

## Rebuilding `internal/emulator/emulator.wasm`

kisui embeds the committed `internal/emulator/emulator.wasm` (the Rust in `emulator/`), so `go build` needs no Rust. When you change `emulator/` or `Cargo.lock`, rebuild it and commit the result; `nix flake check` fails when the committed file and the source disagree.

The bytes of a wasm depend on the machine that built it (OS and CPU), so it is always built on **x86_64-linux**, with the source paths pinned by `--remap-path-prefix` (see `emulatorWasm` in `flake.nix`). The check runs only on x86_64-linux for the same reason.

- On x86_64-linux: `scripts/build-emulator.sh`.
- On macOS (or aarch64-linux): run the same script with an x86_64-linux Nix builder (for example the `nix-darwin` linux-builder with Rosetta), or let CI build it. Push the change, open the `emulator-wasm` artifact of the failed `check` run (the job uploads it on purpose), copy `emulator.wasm` over `internal/emulator/emulator.wasm`, and commit it. Never take the file out of build logs.

## Pull requests

- One pull request is one change. Say what changed and why.
- `README.md` and `README.ja.md` describe the same things: change both.
- A change to how kisui-terminal and `shj` talk (`docs/protocol.md`) needs a matching change in [shijimi-editor](https://github.com/mm1995tk/shijimi-editor); link the two.
- CI runs `nix flake check`, `nix run .#tidy` (it must leave no diff) and builds the shell with the updater.
