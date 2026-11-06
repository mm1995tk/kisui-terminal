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

## Pull requests

- One pull request is one change. Say what changed and why.
- `README.md` and `README.ja.md` describe the same things: change both.
- A change to how kisui-terminal and `shj` talk (`docs/protocol.md`) needs a matching change in [shijimi-editor](https://github.com/mm1995tk/shijimi-editor); link the two.
- CI runs `nix flake check`, `nix run .#tidy` (it must leave no diff) and builds the shell with the updater.
