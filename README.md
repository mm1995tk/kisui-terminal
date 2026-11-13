# kisui-terminal

[日本語](README.ja.md)

kisui-terminal is a terminal-centered workspace that works closely with [shijimi-editor](https://github.com/mm1995tk/shijimi-editor): it splits a window into panes and runs terminals (with `shj` inside), videos, images, PDFs and a file tree in them. The name is 汽水 (kisui, brackish water), where the shijimi clam lives.

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

The manual of shijimi-editor explains how `shj` behaves inside kisui-terminal: the panes it opens, videos, opening a URL and the file tree. See its pages [Terminal](https://mm1995tk.github.io/shijimi-editor/manual/terminal/), [Browser](https://mm1995tk.github.io/shijimi-editor/manual/browser/) and [Configuration files](https://mm1995tk.github.io/shijimi-editor/manual/config/) ("Machines in kisui-terminal" and `[server]`).

In a pane, `kisui open <file|url>` shows an image right there in the pane you typed it in, at the cursor, the way `icat` of kitty does (it writes the image to the terminal with kitty's graphics protocol, so it works in the panes of a remote machine too; PNG, JPEG, GIF (the first frame), WebP and BMP, as wide as the pane at most). Other files open in a pane of the same workspace, by their kind: a video, a PDF (by the extension, or by the first bytes when the extension does not tell). A pane of each kind replaces the one already open. `kisui open --pane <image>` opens an image in a pane of its own instead. SVG and AVIF images, images over 16 MB or 10000 pixels, and an image when stdout is not a terminal (a pipe, the shell of a coding agent) open in a pane without `--pane`. An `http`/`https` URL opens in the browser of the computer kisui-terminal runs on (your OS default browser; no pane), the same as `:open-url` in `shj`. A `localhost` URL from a remote (ssh) machine opens through a relay that kisui-terminal runs over a plain ssh session (`kisui relay` on that machine; no ssh port forwarding, so it works where port forwarding is refused too), so it shows the page of the remote machine. It works in the panes of a remote machine too, and only in the panes of kisui-terminal: from any other shell it refuses. `kisui --help` lists the commands.

```sh
kisui open ./diagram.png         # in this pane
kisui open --pane ./diagram.png  # in a pane of its own
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

In the shell of a pane, `pbcopy` and `pbpaste` call `kisui clipboard copy` and `kisui clipboard paste` (`echo hello | pbcopy`), and `pbpaste` asks you every time too. This works the same in the panes of a remote machine. kisui-terminal puts the folder of the two at the front of `PATH` after zsh, bash and fish have read their startup files, so they come before the `pbcopy` of macOS and work the same from a script. Your startup files are not changed. Other shells only get the folder at the front of `PATH`, so the `pbcopy` of macOS can come first when a startup file rebuilds `PATH`.

kisui-terminal keeps a history of the text copied to the clipboard of the computer it runs on: copies made in kisui-terminal and copies made in other apps (a browser, say). It keeps the last 20 texts for 12 hours, and saves them in `clipboard-history.json`, readable only by you, in its data directory (`~/Library/Application Support/dev.mm1995tk.kisui-terminal` on macOS, `~/.local/share/dev.mm1995tk.kisui-terminal` on Linux), so they stay after you close it. Copies that a password manager marks as secret are not kept. Images are not kept.

Press `Cmd+Shift+H` (macOS) or `Ctrl+Shift+H` (Linux) to open the history as a list, newest first. Type to filter it, move with the up and down keys (or `Ctrl+J` / `Ctrl+K`), then press `Enter` to paste the selected text into the pane you were typing in, or `Shift+Enter` to put it back on the clipboard. `Esc` closes the list without doing anything.

Outside kisui-terminal (while you use another app), press `Option+Space` (macOS) or `Alt+Space` (Linux) to bring up a small window with the history. The main window of kisui-terminal stays where it is. Choose a text with the up and down keys (or `Ctrl+J` / `Ctrl+K`) and press `Enter`: it goes back on the clipboard, the window closes and you are back in the app you were using, so press `Cmd+V` (`Ctrl+V` on Linux) to paste it. kisui-terminal does not paste for you, so it needs no Accessibility permission on macOS. `Esc` closes the window without doing anything and takes you back to that app. This works only while kisui-terminal is running. On Linux, the key does not arrive when the window manager takes `Alt+Space` first (the window menu of GNOME or KDE, for example); unbind it there. In a Wayland session the key may not be caught at all (it may arrive only while an X11 app has the focus).

`kisui pane split --right` / `--down` splits the pane you type it in, to the right or down, and gives the new pane the focus. A command after it runs in the new pane instead of a shell (`kisui pane split --down htop`). The pane closes when the command ends, so to keep the output of a short command, run a shell that runs it, such as `kisui pane split --down sh -c "ls; exec sh"`. It refuses when the pane would be left smaller than 20 columns or 5 rows, the same as splitting with the keys. `kisui pane title <name>` puts a name on a thin band above the pane (an empty name takes it away). The server keeps the name, so it stays when you reopen the window.

```sh
kisui pane split --right
kisui pane split --down npm run dev
kisui pane title build
```

`kisui update` makes the app look for a newer version now, so you do not have to close and reopen it (it looks once at start-up otherwise). When there is one, the app shows the same "a new version is available" notice as at start-up, even if you closed it with "Later"; "Update and restart" works as it does there, and the shells of the panes stay (the server hands over). `kisui update` prints what the app found: that there is a newer version, that this is the newest, or that this build has no auto update (the Nix build and Linux other than the AppImage: update it with `nix flake update`, or install the new version). It works in the panes of a remote machine too: the app on your computer looks and shows the notice. `kisui update --help` shows its usage.

`kisui skill install [folder]` writes a skill (`SKILL.md`) that teaches a coding agent such as Claude Code how to use `kisui open`, `kisui notify`, `kisui clipboard` and `kisui pane` in a pane. It writes to `~/.claude/skills/kisui-terminal/` when you give no folder. The skill is built into the `kisui` binary, so it matches the version you have. It tells the agent not to run `kisui clipboard paste` on its own.

```sh
kisui skill install
kisui skill install ./my-skills/kisui-terminal
```

kisui-terminal reads its settings from the same `config.toml` as `shj` (`~/.config/shijimi-editor/config.toml`, or `shijimi-editor-nightly/` for the nightly):

- `[[gui.machines]]`: the machines shown in the sidebar (`ssh = "dev-vm"`, `name = "dev"`).
- A URL on the screen (underlined) opens in your OS default browser on `cmd + click` or `cmd + shift + click` (`ctrl + click` or `ctrl + shift + click` outside macOS). Only http and https URLs open. For a `localhost` URL shown in a terminal on a remote (ssh) machine, kisui-terminal relays the port over ssh (`kisui relay`) and opens a local address, because your own browser would reach your own localhost. If nothing listens on that port, it says so instead of opening the browser. While an app has mouse reporting on (vim, tmux, htop, `shj`), a plain `cmd + click` goes to the app; use `cmd + shift + click`. The `url_open` setting under `[gui]` from older versions is ignored.
- `[server]`: `idle_stop_days` (days `kisui serve` stays up with no window connected; default 7, 0 = never) and `start_dir` (the folder a new workspace's shell starts in).
- `ui-language`: the language of kisui's own messages, like `shj`'s.

On a remote machine (ssh), kisui-terminal installs its own `kisui` and `shj` under `~/.cache/kisui-terminal/<version>/` after asking you; it does not touch the `shj` on the PATH there.

### Keys

You do not have to remember the keys. Press the leader, `Cmd+K` (macOS) or `Ctrl+Shift+K` (Linux), and the keys you can press next appear at the bottom left of the window, each with what it does. Press one to run it, or to go one level down into a group. `Backspace` goes back a level, `Esc` (or the leader again) leaves, and `?` shows every key in a list. A key that is not in the list is dropped and leaves the leader, so a stray letter never reaches the shell. `shj` has its own keys (`Space` and the rest) and they work in a pane as before: kisui-terminal takes a key only when it is the leader or one of the shortcuts below, never `Ctrl` + a letter or `Alt` + a key on their own.

| Keys after the leader | What it does                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `h` `j` `k` `l`       | Move to the pane on the left, below, above, on the right. You can keep pressing them. `Tab` goes back to the pane you were in. |
| `w`                   | Workspaces: `j` `k` the next / previous workspace in the sidebar (across machines; it wraps around at the ends; you can keep pressing them, and the file tree opens when you leave the leader), `h` `l` the previous / next machine (the workspace you last used on it, or the first; a machine with no workspace gets selected too, so `m` and `n` act on it), `1`-`9` the nth in the sidebar, `n` new on this machine, `x` close, `r` rename (an empty name goes back to the automatic one; the name is kept by `kisui serve`, so it shows from any machine; the right-click menu of a workspace card has it too), `Tab` back to the last one |
| `m`                   | Machines (the one of the current workspace): `a` add, `n` rename, `d` remove from the list, `x` disconnect, `r` reconnect |
| `p`                   | Panes: `v` split right, `s` split down, `x` close, `z` hide or show the panes other than the primary one, `r` resize (and `h` `j` `k` `l` as above) |
| `b`                   | Open or close the sidebar (it closes only when you press this; it opens by itself when the file tree or CHANGES gets the focus, e.g. `Space e` or `Space E` in `shj`, but not for the automatic focus right after `shj` starts; kisui-terminal remembers it) |
| `y`                   | The clipboard history                                                                                         |
| `v`                   | Size of the display: `+` bigger, `-` smaller, `0` back to normal                                              |
| `n`                   | Notices: `a` press the main button of the newest one, `d` close it, `g` bring forward the pane that last sent an OS notification |

Some of them also have a shortcut that does not go through the leader (the list from `?` shows the ones for your OS). `Cmd+Shift+W` / `Ctrl+Shift+W` and `Cmd+Shift+P` / `Ctrl+Shift+P` open the workspaces and the panes group at once. `Cmd+D` / `Ctrl+Shift+D` and `Cmd+Shift+D` / `Ctrl+Shift+E` split a pane, `Cmd+R` / `Ctrl+Shift+R` is resize, `Cmd+Shift+Enter` / `Ctrl+Shift+M` hides the other panes, `Cmd+Shift+H` / `Ctrl+Shift+H` is the clipboard history, `Cmd+=` `Cmd+-` `Cmd+0` (`Ctrl+=` `Ctrl+0` on Linux) change the size of the display, and on macOS `Cmd+1`-`Cmd+9` pick a workspace and `Cmd+W` closes a pane. These keys used to exist and are gone, because `shj` and the shell use them: `Ctrl+Shift+Arrow` and `Cmd+Option+Arrow` (move between panes: use the leader), `Ctrl+Shift+M` on macOS, and `Ctrl+-` on Linux (size: use the leader).

In an image pane (one opened with `kisui open --pane`, or from `shj`), these keys work while the pane has the focus (they are not in the leader; `?` lists them): `+` / `=` zoom in, `-` zoom out, `0` fit the pane again, `h` `j` `k` `l` or the arrow keys move the visible part while zoomed in, and `Esc` goes back to the terminal. With the mouse, `Ctrl` + the wheel or a pinch on the trackpad zooms (around the pointer), and dragging moves the image while zoomed in. They do not clash with the keys that change the size of the whole display (`Cmd+=` and the others), which carry a modifier.

The file tree, the changes list and a video pane have keys of their own too, which work only while they have the focus. `?` there lists them (and `?` in the leader also lists the keys of the place that has the focus, above the leader's). In the file tree, `c` copies the name, `m` runs "move here" (cd in the terminal; folders only), and `.` or the Menu key opens the right-click menu on the selected row; these used to be in the right-click menu only. In the list in a dialog (the clipboard history, the candidates when you add a remote), `Ctrl+J` / `Ctrl+K` select the next / previous row, as `↓` `↑` do.

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
