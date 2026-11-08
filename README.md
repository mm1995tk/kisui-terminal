# kisui-terminal

[日本語](README.ja.md)

kisui-terminal is a terminal-centered workspace that works closely with [shijimi-editor](https://github.com/mm1995tk/shijimi-editor): it splits a window into panes and runs terminals (with `shj` inside), videos, images, PDFs, browser pages and a file tree in them. The name is 汽水 (kisui, brackish water), where the shijimi clam lives.

It is a separate app from shijimi-editor, with its own version and releases. It ships with the `shj` it was tested with, and the terminals in its panes use that `shj` first (the `shj` you install yourself is still used outside kisui-terminal). How kisui-terminal and `shj` talk to each other is written in [docs/protocol.md](docs/protocol.md); the two share no code.

## Install

Linux (x86_64 and aarch64) and macOS on Apple silicon (arm64); macOS on Intel is not supported, neither as the app nor as a remote machine. Every release is at [Releases](https://github.com/mm1995tk/kisui-terminal/releases); the AppImage and the `.dmg` update themselves.

- **AppImage**: `chmod +x kisui-terminal-linux-*.AppImage` and run it. The AppImages are added to the latest release once every two weeks, so a new release may have only the `.dmg` for a while.
- **`.dmg`**: the app is not signed by Apple, so macOS refuses to open it the first time. Drag `kisui-terminal.app` to Applications, open it once (macOS says it cannot be verified; close that dialog), then go to **System Settings → Privacy & Security** and press **Open Anyway** next to the line about `kisui-terminal`. From then on it opens normally. Or run `xattr -dr com.apple.quarantine /Applications/kisui-terminal.app` once. The app is only ad-hoc signed, so after each update you need to grant again the permissions you gave it under Privacy & Security (such as **App Management**).

The nightly build of main is `kisui-terminal-nightly` in the [`nightly` pre-release](https://github.com/mm1995tk/kisui-terminal/releases/tag/nightly) (a `.dmg` only; on Linux, use Nix for the nightly). It has its own name and identifier, so it can be installed next to the stable one.

With Nix, kisui-terminal is the `kisui-terminal` package (`kisui-terminal-nightly` for the nightly, installed under that name), or `programs.kisui-terminal.enable = true;` in home-manager with the flake's `homeManagerModules.default`. Built with Nix it has no auto update: update it with `nix flake update`.

```sh
nix run github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal#kisui-terminal-nightly
```

## Using it

The manual of shijimi-editor explains how `shj` behaves inside kisui-terminal: the panes it opens, videos, the browser pane and the file tree. See its pages [Terminal](https://mm1995tk.github.io/shijimi-editor/manual/terminal/), [Browser](https://mm1995tk.github.io/shijimi-editor/manual/browser/) and [Configuration files](https://mm1995tk.github.io/shijimi-editor/manual/config/) ("Machines in kisui-terminal" and `[server]`).

In a pane, `kisui open <file|url>` shows a file or a page in a pane of the same workspace, by its kind: a video, an image, a PDF (by the extension, or by the first bytes when the extension does not tell), or an `http`/`https` URL in a browser pane. A pane of each kind replaces the one already open. It works in the panes of a remote machine too, and only in the panes of kisui-terminal: from any other shell it refuses. `kisui --help` lists the commands.

```sh
kisui open ./diagram.png
kisui open ./talk.mp4
kisui open ./paper.pdf
kisui open https://example.com/
```

`kisui notify <text>` shows a desktop notification on the computer the window runs on, to tell you that a long command has ended. `kisui clipboard copy` puts the text of stdin on that computer's clipboard, and `kisui clipboard paste` prints the text on it. Since reading your clipboard is risky, kisui-terminal asks you every time `paste` reads it, and prints it only when you allow it. All three work the same in the panes of a remote machine.

```sh
make build; kisui notify "build: $?"
echo hello | kisui clipboard copy
kisui clipboard paste > note.txt
```

kisui-terminal keeps a history of the text copied to the clipboard of the computer it runs on: copies made in kisui-terminal and copies made in other apps (a browser, say). It keeps the last 20 texts for 12 hours, and saves them in `clipboard-history.json`, readable only by you, in its data directory (`~/Library/Application Support/dev.mm1995tk.kisui-terminal` on macOS, `~/.local/share/dev.mm1995tk.kisui-terminal` on Linux), so they stay after you close it. Copies that a password manager marks as secret are not kept. Images are not kept.

`kisui pane split --right` / `--down` splits the pane you type it in, to the right or down, and gives the new pane the focus. A command after it runs in the new pane instead of a shell (`kisui pane split --down htop`). The pane closes when the command ends, so to keep the output of a short command, run a shell that runs it, such as `kisui pane split --down sh -c "ls; exec sh"`. It refuses when the pane would be left smaller than 20 columns or 5 rows, the same as splitting with the keys. `kisui pane title <name>` puts a name on a thin band above the pane (an empty name takes it away). The server keeps the name, so it stays when you reopen the window.

```sh
kisui pane split --right
kisui pane split --down npm run dev
kisui pane title build
```

kisui-terminal reads its settings from the same `config.toml` as `shj` (`~/.config/shijimi-editor/config.toml`, or `shijimi-editor-nightly/` for the nightly):

- `[[gui.machines]]`: the machines shown in the sidebar (`ssh = "dev-vm"`, `name = "dev"`).
- `[server]`: `idle_stop_days` (days `kisui serve` stays up with no window connected; default 7, 0 = never) and `start_dir` (the folder a new workspace's shell starts in).
- `ui-language`: the language of kisui's own messages, like `shj`'s.

On a remote machine (ssh), kisui-terminal installs its own `kisui` and `shj` under `~/.cache/kisui-terminal/<version>/` after asking you; it does not touch the `shj` on the PATH there.

## Development

Use the Nix devShell (Go, gopls, gomod2nix, git, Node.js, Rust, and on Linux the WebView libraries). With direnv, `.envrc` enters it automatically. Every command runs from the root of the repository: `go.mod` (`kisui`, the server), `package.json` (the web UI, sources in `app/`) and `Cargo.toml` (a workspace whose member is the Tauri shell, `app/src-tauri`) are all there.

```sh
nix develop
npm ci                 # the web UI (once, and after package-lock.json changes)
go test ./...          # kisui
npm test               # the web UI
cargo test             # the Tauri shell
go build -o target/dev/kisui ./cmd/kisui   # the kisui the window starts (SHIJIMI_KISUI)
SHIJIMI_KISUI=$PWD/target/dev/kisui npm run tauri dev   # run it (outside the devShell: nix run .#dev)
nix fmt                # format everything
nix flake check        # every check CI runs: formatting, go test, the build and its tests
```

In `tauri dev` the terminals use the `shj` on your PATH; the built app ships its own (`packaging/`).

The layout: `app/` is the window (Solid + TypeScript in `src/`, the Tauri shell in `src-tauri/`), `cmd/kisui` and `server/`, `attach/`, `rpc/`, `config/` are `kisui` (Go), `internal/` is what kisui keeps of the agreement with `shj` (`ctl`), the PTY (`term`), the build (`buildinfo`) and its messages (`i18n`). `docs/design/` is the design history.

Releases are described in [docs/releasing.md](docs/releasing.md).

## License

MIT
