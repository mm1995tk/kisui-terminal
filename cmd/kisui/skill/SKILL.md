---
name: kisui-terminal
description: Use the kisui commands from inside a pane of kisui-terminal - show a file or a web page in another pane (kisui open), split the pane (kisui pane split), name the pane (kisui pane title), send a desktop notification when long work ends (kisui notify), and use the clipboard of the user's computer (kisui clipboard copy). Use it when you run in a kisui-terminal pane and the user wants to see a result, be told when something finishes, or get text onto their clipboard.
---

# kisui-terminal

kisui-terminal is a terminal workspace. Its panes run a shell, and `kisui` is the command that talks to the window from inside a pane. This skill is the usage of its subcommands.

## Check that you are in a pane

The commands work only in a pane of kisui-terminal (also in a pane of a remote machine listed in the sidebar; not in a shell you opened yourself with `ssh`). Any other shell makes them fail, so check first:

```sh
[ -n "$KISUI_PANE" ] && echo in a pane || echo not in a pane
```

If you are not in a pane, do not use these commands and do not try to work around the failure.

`kisui notify` and `kisui clipboard` (and `pbcopy` / `pbpaste`) also need a terminal (`/dev/tty`), and the shell of a coding agent may have none. If they fail with "there is no terminal to talk to", tell the user and do not work around it. `kisui open` and `kisui pane` do not need a terminal.

## Commands

<!-- Each command is `kisui <name>` on its own heading. A test checks that every command of `kisui --help` has a heading here; add one when you add a command. -->

### kisui open <file|url>

Show an image in your own pane (at the cursor, like kitty's `icat`), or a video, a PDF or an `http` / `https` page elsewhere (a pane of the same workspace; the kind is judged by the extension or the first bytes of the file; a pane of the same kind that is already open is replaced). `--pane` opens an image in a pane of its own instead. Without a terminal on stdout (the shell of a coding agent), an image also opens in a pane. Use it when the user should look at something you made or found: a diagram, a screenshot, a PDF, a running dev server.

```sh
kisui open ./diagram.png         # in this pane
kisui open --pane ./diagram.png  # in a pane of its own
kisui open https://example.com/
```

### kisui notify <text>

Show a desktop notification on the computer the window runs on. Use it to tell the user that long work (a build, a test run, a task they are waiting for) has ended.

```sh
make build; kisui notify "build: $?"
```

### kisui clipboard copy

Put the text of stdin on the clipboard of the computer the window runs on. Use it when the user asks you to copy something.

```sh
echo hello | kisui clipboard copy
```

`pbcopy` does the same in these panes (`echo hello | pbcopy`).

### kisui clipboard paste

Print the text on the clipboard of the computer the window runs on. **Do not run this on your own.** Every call makes kisui-terminal ask the user whether to allow it, and the clipboard can hold something private. Run it only when the user asks you to read their clipboard. `pbpaste` asks in the same way, so the same rule applies.

### kisui pane split --right|--down|--left|--up [command ...]

Split the pane you run in to the right, down, left or up and move the focus to the new pane. With a command, the new pane runs it instead of a shell, and closes when the command ends; to keep the output of a short command, end with a shell (`sh -c "ls; exec sh"`). It is refused when `--right` or `--left` would leave a pane narrower than 20 columns, or `--down` or `--up` shorter than 5 rows. The focus moves to the new pane, so what the user is typing goes there too: split only when the user asks or the work needs it. Use it to start a dev server or a watcher beside your work.

```sh
kisui pane split --right
kisui pane split --down npm run dev
```

### kisui pane title <name>

Show a name on the pane, on the thin bar above it. An empty name takes the name away. Use it to tell panes apart.

```sh
kisui pane title build
```

### kisui update

Make the window look for a newer version of kisui-terminal now and, when there is one, show its "a new version is available" notice. It prints that the version is the newest, that there is a newer one, or that this build has no auto update. **Do not run this on your own.** It is for the user, who decides when to update; run it only when the user asks you to check for an update. The update itself (replace and restart) is done by the user in the notice.

```sh
kisui update
```
