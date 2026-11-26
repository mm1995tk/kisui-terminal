# Database connections

`kisui serve` can connect to MySQL and PostgreSQL and run SQL for the window. This page is about the settings: which databases, and where their passwords come from.

You use these connections in a database tab of the window (the leader, then `n` and `d`; see the README), and a coding agent uses them with the `kisui db` commands (below). This page is about the part under it: the settings, and the requests `kisui serve` answers (`db.connections`, `db.query`, `db.cancel`, `db.schema`, `db.history`, `db.elevate`; see [design/gui-protocol.md](design/gui-protocol.md)).

`kisui serve` is the one that connects, not the window. On a remote machine (ssh), `kisui serve` runs on that machine, so a database that only that machine can reach works with no tunnel. Write a connection in the settings of the machine that should connect.

## Settings

Connections go in `config.toml` (or `config.local.toml`) in `~/.config/kisui-terminal/` on the machine where `kisui serve` runs:

```toml
[[db.connections]]
name = "shop (dev)"
kind = "postgres"
host = "localhost"
port = 5432
user = "app"
database = "shop"

[[db.connections]]
name = "shop (production)"
kind = "mysql"
host = "db.example.com"
user = "reader"
database = "shop"
read-only = true
```

| Key                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                 | What you call the connection. Required, up to 100 characters, and no two connections of a machine have the same name.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `kind`                                 | `"postgres"` or `"mysql"`. Required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `host`                                 | A host name or an address. `"localhost"` when left out. A value that starts with `/` is a Unix socket: the folder of the socket for PostgreSQL (`/run/postgresql`), the socket file for MySQL (`/run/mysqld/mysqld.sock`).                                                                                                                                                                                                                                                                                                                                                |
| `port`                                 | `5432` (PostgreSQL) or `3306` (MySQL) when left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `user`                                 | Who logs in. Required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `database`                             | The database to open. When left out, PostgreSQL opens the one named like the user, and MySQL selects none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `read-only`                            | `true` makes every statement run in a read-only transaction: the database refuses anything that writes. `false` when left out. It holds for everybody, whatever the permissions below say.                                                                                                                                                                                                                                                                                                                                                                                |
| `tls`                                  | How the connection uses TLS. `"prefer"` (when left out): TLS when the database offers it, without checking the certificate (what `psql` and `mysql` do by default). `"disable"`: never TLS. `"require"`: always TLS, without checking the certificate; a database that offers no TLS is not logged in to. `"verify"`: always TLS, and the certificate must be signed by a certificate authority you trust and be for the `host` of the connection (PostgreSQL's `sslmode=verify-full`). A Unix socket uses no TLS, so on one only `"prefer"` and `"disable"` are allowed. |
| `tls-ca`                               | The file (PEM) of the certificate authority `"verify"` checks the certificate with, for a database whose certificate your own authority signed. An absolute path, or one that starts with `~`. When left out, the certificate authorities of the OS are used. Written only with `tls = "verify"`.                                                                                                                                                                                                                                                                         |
| `human-permission`, `agent-permission` | The name of a permission (below) for you and for a coding agent. Left out, you do what `read-only` says, and an agent runs nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `variants`                             | The environments of the connection (below). Left out, the connection is one database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

- The lists of `config.toml` and `config.local.toml` are merged by `name`. A connection that both files have is the one of `config.local.toml`, as a whole, with all its variants: the keys and variants only the entry of `config.toml` has are not taken over. A connection that only one file has stays. The order is the one of `config.toml`, then the connections only `config.local.toml` has.
- An empty list in `config.local.toml` (`connections = []` under `[db]`) adds nothing and removes nothing. There is no way to remove a connection of `config.toml` from `config.local.toml`: remove it in `config.toml`.
- A connection of `config.local.toml` with a mistake still hides the connection of `config.toml` with the same name: it is left out and the mistake is reported, so that the connection does not run with the settings you meant to change.
- The settings are read each time the list is asked for, so a connection you add shows without restarting `kisui serve`.
- **From the window.** In the window that lists the connections (the leader, then `n` and `d`), `a` adds a connection to this PC, and `e` and `d` edit and remove the selected one. The window writes `[[db.connections]]` of `config.local.toml` of the PC it runs on, never `config.toml`, and the change shows in the list at once. It does not change a connection of `config.toml` (it says why; adding one with the same name, which would take its place, is refused too), nor one of a remote machine (edit `config.local.toml` on that machine). The rows of the connections written in `config.local.toml` of this PC have a mark. A connection you wrote by hand in `config.local.toml` over one of `config.toml` with the same name is one of `config.local.toml`: the window edits and removes it, and removing it brings back the connection of `config.toml` (the window says so, and the mark goes away). It edits `name`, `kind`, `host`, `port`, `user`, `database`, `read-only`, `tls` and `tls-ca`; write `variants` and the permissions in the file (a connection that has them can be removed from the window, not edited). It checks what you typed as `kisui serve` does, and refuses it for the same reasons, plus a `host` that is not a host name, an address or a socket path (a URL, `user@host` or a connection string such as `host=db password=…`), and a URL in `name`, `user` or `database`. It has no field for a password and never writes one: the password is asked when you connect, as below. A `config.local.toml` the window creates can be read and written only by you (`0600`); one that exists keeps its permissions.
- A mistake in a connection does not stop `kisui serve`. That connection is left out of the list, and the mistake is reported with it. A key that is not in the table above is a mistake too, so that a misspelt `read-only` does not give a connection that can write.
- `read-only` is there to prevent accidents, not to replace rights. For a database nobody may write to, log in as a user that can only read.

### Variants: one connection in several environments

When the same database exists in several environments (your machine, a container, dev, staging, production), write it as one connection with a variant for each, instead of one connection per environment:

```toml
[[db.connections]]
name = "shop"
kind = "postgres"
user = "app"
database = "shop"

[[db.connections.variants]]
name = "local"

[[db.connections.variants]]
name = "dev"
host = "dev.example.com"

[[db.connections.variants]]
name = "prod"
host = "db.example.com"
user = "reader"
read-only = true
```

| Key of a variant                                                                                         | Meaning                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                                                   | What you call the variant. Required, up to 100 characters, without a `/`, and no two variants of a connection have the same name. |
| `host`, `port`, `user`, `database`, `read-only`, `tls`, `tls-ca`, `human-permission`, `agent-permission` | As in the table above, for this variant.                                                                                          |

- A variant takes the keys it does not write from its connection, and the defaults of the table above when the connection does not write them either. Above, `local` is `app@localhost:5432/shop`, and `prod` is `reader@db.example.com:5432/shop`, read-only. `read-only = true` on the connection makes every variant read-only, except one that writes `read-only = false`.
- `kind` is written on the connection only: the variants of a connection are the same kind of database.
- `user` may be written on the connection, on a variant, or on both, as long as every variant ends up with one.
- `tls-ca` written on the connection goes to every variant with it, and is a mistake on a variant whose `tls` is not `"verify"` (a `local` variant with `tls = "disable"`, say). Then write `tls-ca` on the variants that verify, not on the connection.
- You choose the variant when you open a database tab: the window lists each variant as its own row, `shop (local)`, `shop (dev)`, `shop (prod)`, in the order written. A tab stays on the variant it was opened with.
- A connection with variants is not a database by itself: only its variants are listed.
- A mistake in one variant leaves the whole connection out of the list (all its variants), and is reported with it.
- When you add variants to a connection you already use, its database tabs that are open stop working (they name no variant): close them and open the variant you want. The history and the keychain item of the connection are not carried over to a variant (see below).

## Permissions: what you and a coding agent may do

A permission has a name and says how far SQL is run. A connection (or each of its variants) names one for you, the person at the window, and one for a coding agent. So an agent can be free on your machine and only read in production, while you stay free in both:

```toml
[db.permissions.free]
run = "free"
propose = true

[db.permissions.reader]
run = "read"
propose = true
agent-user = "agent_ro"

[[db.connections]]
name = "shop"
kind = "postgres"
user = "app"
database = "shop"

[[db.connections.variants]]
name = "local"
agent-permission = "free"

[[db.connections.variants]]
name = "prod"
host = "db.example.com"
human-permission = "reader"
agent-permission = "reader"
```

| Key of a permission | Meaning                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run`               | How far statements are run. Required. `"none"`: nothing is run. `"read"`: every statement runs in a read-only transaction, as with `read-only`, so the database itself refuses anything that writes. `"free"`: statements run as they are. |
| `propose`           | `true` lets a coding agent write SQL into the input of a database tab, for you to read and run. `false` when left out. It says nothing for a person.                                                                                       |
| `agent-user`        | The database user a coding agent logs in as, instead of the `user` of the connection. Left out, the agent logs in as the `user` of the connection. It says nothing for a person.                                                           |
| `elevate-to`        | The name of another permission: the one to use while this permission is elevated for a time (below). Left out, the permission cannot be elevated. Written together with `elevate-max`.                                                     |
| `elevate-max`       | The longest time this permission can be elevated for at once: whole numbers with `h`, `m` and `s`, in that order and each at most once (`"30m"`, `"1h"`, `"1h30m"`). Written together with `elevate-to`.                                                                         |

- **Who is who.** A request of the window is yours. A request of the `kisui db` commands, which a coding agent calls from a shell, is the agent's (see [For a coding agent](#for-a-coding-agent-the-kisui-db-commands) below).
- **Nothing named.** A connection without `human-permission` works as it always did: you run freely, or read only with `read-only = true`. A connection without `agent-permission` lets an agent run nothing, and lets it write into the input (so that you are the one who runs what it wrote).
- **`read-only = true` wins.** With it, nobody is above `"read"` on that connection, whatever their permission says: naming a permission never makes a read-only connection writable.
- **`"read"` with `propose`** is the mix for production: the agent runs the statements that read, and writes the ones that change something into the input for you to run.
- **The list of schemas and tables** can be read at every level, `"none"` too: it has the names and types of tables and columns, not rows.
- **Finer rights go in the database.** kisui-terminal does not read a statement to refuse it, so there is no "INSERT only" or "no DDL" here. Give the agent a user of its own (`agent-user`) and `GRANT` that user what it may do. The agent's user opens the same database as the connection (for PostgreSQL without `database`: the one named like the `user` of the connection).
- A variant takes `human-permission` and `agent-permission` from its connection when it does not write them.
- `[db.permissions]` in `config.local.toml` replaces the one of `config.toml` as a whole, apart from the list of connections: a file with only connections uses the permissions of the other file.
- A connection that names a permission nobody wrote, or one with a mistake, is left out of the list and reported, so that it never runs with other rights than its settings show. A key of a permission that is not in the table above is a mistake too.
- Like `read-only`, a permission is there to prevent accidents. It is checked by `kisui serve`, for requests that say who they are from. A program that runs as you on that machine can read your password files as well as you can, so for a database an agent must not write to, the rights of its database user are what holds.
- **What the permissions do not hold against.** They are not a wall against a program that runs as you on that machine (a program in a pane, or a coding agent that does not keep to the `kisui db` commands). Such a program can talk to `kisui serve` the way the window does, so it can run SQL with your permission instead of the agent's, elevate a permission, and use a password you typed in the window, which `kisui serve` keeps in memory while it runs. kisui-terminal cannot tell that program from the window: both run as you.
- **What `"read"` and `read-only` do not hold against.** They rely on the read-only transaction of the database, which refuses writes to tables. A database user with strong rights can still do other things in it, or leave it: write a file on the database server (`COPY … TO PROGRAM` for a PostgreSQL superuser, `SELECT … INTO OUTFILE` with the MySQL `FILE` right), change server settings, or call a procedure that commits and starts a transaction that writes. kisui-terminal does not read statements to refuse these one by one. So give the agent a database user of its own (`agent-user`) that has only the rights it needs, and no superuser, `FILE` or similar rights.

### Elevating a permission for a time

You can work with a weak permission every day (read only in production, say) and make it stronger only when you need to, for a time you choose. When the time is over, the permission goes back by itself.

```toml
[db.permissions.free]
run = "free"

[db.permissions.reader]
run = "read"
propose = true
elevate-to = "free"   # while elevated, this permission is "free"
elevate-max = "30m"   # for at most 30 minutes at a time

[[db.connections]]
name = "shop"
kind = "postgres"
user = "app"

[[db.connections.variants]]
name = "prod"
host = "db.example.com"
human-permission = "reader"
agent-permission = "reader"
```

- **Elevate** with `p` in the database tab window (the leader, then `a`, while a database tab of the connection is shown). A window lists the permissions of that connection that can be elevated, yours and the coding agent's (choose with `↓` `↑` or Ctrl+J / Ctrl+K). Type the time (`30m`, `1h`, `1h30m`; the box starts with the longest time allowed) and press `Enter`. A time longer than `elevate-max` is refused. Elevating a permission that is already elevated sets its time again, counted from now.
- **End it before the time** with `P` in the same window: every elevated permission of that connection goes back at once, yours and the agent's.
- **Only you elevate.** It is done in the window, for your own permission or for the agent's. The `kisui db` commands have no command for it, so a coding agent cannot elevate its own permission. Like the permissions themselves, this is there to prevent accidents (see the last point of the list above): what holds against a program that runs as you is the rights of the database user.
- **What is elevated** is one permission of one connection: of one variant, and either yours or the agent's. Elevating yours on `shop (prod)` changes nothing for the agent, and nothing on `shop (dev)`.
- **While it is elevated**, the database tab shows whose permission is elevated, to what, and the time left; `kisui db connections` shows the time left for the agent's permission (`ELEVATED`).
- **`read-only = true` still wins.** On such a connection an elevated permission is not above `"read"` either.
- **One step only.** While a permission is elevated, the `elevate-to` of the permission it became is not followed.
- **When `kisui serve` stops**, or is replaced by a new version, every permission is back to what the settings say: what is elevated is kept in the memory of `kisui serve` only, never in a file.
- **A statement that is running when the time is over** is not stopped. The permission is checked when a statement starts, so the first statement that starts after the time runs with the permission of the settings.
- **When you change the settings while a permission is elevated**: if the connection now names another permission, or the permission it is elevated to is another one or was changed itself (its `run`, say), the permission goes back at once, so that it is never elevated to something you did not see when you elevated it; if `elevate-max` is now shorter, the elevation ends at the new limit, counted from when it started.
- **Mistakes.** `elevate-to` without `elevate-max` (or the other way round), an `elevate-to` that names no permission, one that names the permission itself, or an `elevate-max` that is not a time: the permission is reported as a mistake, and the connections that name it are left out of the list, like any other mistake in a permission.

## For a coding agent: the `kisui db` commands

A coding agent (Claude Code and the like) that runs in a pane uses the connections with four commands, from its shell. `kisui serve` of the machine of the pane connects and logs in, as it does for a database tab, so the agent needs no client and never sees a password. Every request of these commands is the agent's: the permission of the agent on the connection (above) decides what it may do, and there is no way to ask as you.

```sh
kisui db connections                       # the connections, and what the agent may do on each
kisui db schema shop                       # the tables and views of a connection
kisui db schema --variant prod shop orders # the columns of one table
kisui db query --variant prod shop 'SELECT count(*) FROM orders'
kisui db propose --variant prod shop "UPDATE orders SET status = 'cancelled' WHERE id = 42"
```

| Command | What it does | Permission |
| --- | --- | --- |
| `kisui db connections [--json]` | Lists the connections of this machine, a line for each variant, with `RUN` (`none`, `read` or `free`) and `PROPOSE` (`yes` or `no`) of the agent, and `ELEVATED`: the time left while you have elevated the agent's permission (`12m left`), `-` otherwise. | Always allowed. |
| `kisui db schema [--variant <variant>] [--json] <connection> [<table>]` | Lists the tables and views; with a table (`users` or `public.users`), its columns and their types. | Always allowed (names and types, not rows). |
| `kisui db query [--variant <variant>] [--max-rows <n>] [--json] <connection> <sql\|->` | Runs one statement and prints its rows as a table: up to 100 rows, or `--max-rows` (at most 10000). `-` reads the SQL from stdin. | `run`: refused with `"none"` (and when no permission is named); with `"read"` the database refuses what writes. |
| `kisui db propose [--variant <variant>] <connection> <sql\|->` | Writes the SQL into the input of a database tab of the window. It does not run it: you read it and run it, with your own permission. | `propose` (allowed when no permission is named). |

- **The connection** is pointed at by its `name`, and a variant with `--variant`. The connections are the ones of the machine the pane is on; the commands take no `--machine`.
- **`--json`** prints what `kisui serve` answers (the results of `db.connections`, `db.schema` and `db.query` in [design/gui-protocol.md](design/gui-protocol.md)): every value of a row as text, or `null`. In the table, NULL is `NULL`, and a line break or a tab in a value is written `\n` or `\t`.
- **No password is asked for.** An agent should not write a password on a command line, so the commands take none. The password must be where `kisui serve` finds it (below): the keychain or the file, or, when the agent logs in as the `user` of the connection, the password you typed in a database tab, which `kisui serve` remembers until it stops. Otherwise the command fails and says so.
- **`kisui db query` waits as long as the statement runs.** Stopping the command (Ctrl+C, or the agent's own time limit) makes the database stop the statement.
- **Where `kisui db propose` writes.** Into a database tab of that machine, connection and variant in the workspace you are in; when it has several, the one that is shown, else the first; when it has none, a tab is opened at the end of the workspace. The focus does not move, and a short notice says what was written where.
  - When the input is empty (or already holds the same SQL), it is written at once.
  - When the input holds other SQL, the window asks you first, showing both: `Enter` (or "Replace") replaces it, `Esc` (or "Cancel") keeps yours. `Enter` is not taken in the first half second, so that a key you were typing elsewhere does not answer. When you say no, the command fails with "declined". It waits for you for 90 seconds; after that (or when the command is stopped) the question closes and nothing is written.
  - It needs the window: with the window closed, the command fails.
- **The statements the agent runs are kept in the history** of the connection, marked as the agent's (below). SQL written with `kisui db propose` is not: it gets there when you run it.
- `kisui skill install` writes a skill that teaches a coding agent these commands (see the README).

## Passwords

A password is never written in `config.toml`; a `password` key is reported as a mistake. `kisui serve` looks for the password of a connection in this order, on the machine where it runs:

1. **A password you typed in the window that worked.** `kisui serve` keeps it in memory until it stops; it is not written to any file or to the keychain. Each variant is asked for by itself: a password typed for one variant is not sent to another.

2. **The keychain (macOS).** A generic password with the service `kisui-terminal-db` and the name of the connection as the account. Add one with:

   ```sh
   security add-generic-password -s kisui-terminal-db -a "shop (production)" -w
   ```

   Each variant of a connection has an item of its own. Its account is the name of the connection, a slash and the name of the variant (`-a "shop/prod"`). The item of one variant is never tried for another. The name of a variant cannot have a `/`, so two variants never share an item. (A connection without variants named `shop/prod` would share that item, so do not name one like that.)

   Use a password of ASCII characters here (`security` cannot hand others back). In a login over ssh the keychain is usually locked; then the next places are used. On Linux there is no keychain step.

3. **`~/.pgpass` (PostgreSQL) or `~/.my.cnf` (MySQL)**, the files the clients of the databases read.
   - `~/.pgpass` (or the file `PGPASSFILE` names): lines of `host:port:database:user:password`, where `*` matches anything. A connection over a Unix socket matches the host `localhost`.
   - `~/.my.cnf`: the `password` of the `[client]` group. When `[client]` also has `user`, `host` or `port`, the password is used only for a connection with the same ones.

The window asks for a password when none of these has one, and when the database refuses the one found in the keychain or in a file (the window says where it was found). The password you type then is tried, and once it works it is used before the one found, so you are asked once until `kisui serve` stops. This is how a connection works when `~/.my.cnf` has a `password` written for another server. When the database refuses a password you typed, `kisui serve` forgets it and the window asks again. A connection whose password is found and works never asks.

**The password of an agent's user** (`agent-user` of a permission) is looked for in the same places, for that user, and the password of the connection's `user` is never tried for it:

1. The keychain: the same account, in the service `kisui-terminal-db-agent` (`security add-generic-password -s kisui-terminal-db-agent -a "shop/prod" -w`).
2. `~/.pgpass`: the line of that user. `~/.my.cnf`: the `password` of `[client]` only when `[client]` also has `user` with the agent's user (a password with no `user` beside it is taken as yours).
3. Nowhere else: the `kisui db` commands do not ask for a password, and the window asks only for yours. Without one in the keychain or in the file, the agent's commands fail and say that a password is needed.

## What a statement does

- One request runs one statement. Several statements separated by `;` in one request are refused by the database, so the window sends them one by one (below).
- **Which statement runs.** `Cmd+Enter` / `Ctrl+Enter` (and the Run button) send the part of the SQL box you selected (when it is one statement, without its `;`). With nothing selected, they send the one statement the cursor is in. The statements of the box are separated by `;`, except that a `;` inside a string, a quoted name or a comment does not separate; in PostgreSQL a `$$ ... $$` (`$tag$ ... $tag$`) body does not either. What counts as a string or a comment follows the kind of the connection: in MySQL a backslash quotes the next character in `'...'` and `"..."`, `#` and `-- ` start a comment, and `/* */` does not nest; in PostgreSQL a backslash quotes only inside `E'...'`, and `/* */` nests. A cursor right after a `;` belongs to the statement before it; a cursor between two statements (a blank line) belongs to the one above. The box is not changed, and nothing marks the statement that runs.
- **Result tabs.** A row of result tabs shows above the result. A result tab holds one statement that ran and its result, with its own page, sorting and side ("Data" or "Structure", below), so going to another tab and back loses nothing. `Cmd+Enter` / `Ctrl+Enter` (and the Run button) replace the result tab that is shown (a tab is added when there is none): changing `WHERE id = 3` and running again does not add a tab. `Cmd+Option+Enter` (macOS) or `Ctrl+Shift+Enter` (elsewhere) runs the same thing into a new result tab, to the right of the one that is shown, so the earlier result stays (macOS does not use `Cmd+Shift+Enter` for this, because that key hides and shows the panes). The label of a tab is the start of its statement (point at it to see all of it); a statement that failed is in red, and one that is running is in italics. To see another tab, click it, press `]` (next) or `[` (previous) while the result table or the row of tabs has focus (on the row of tabs, `→` and `←` work too), or select one in the database tab window (the leader, then `a`) with `j` `k` and press `Enter`. Close a tab with its ×, with the middle mouse button, or with `x` in the database tab window (the tab you select); closing the tab of a statement that is running cancels it. The pages, sorting, export (`e` in the database tab window) and copying work on the tab you see. There are at most 20 result tabs in a database tab: when one more is added, the leftmost ones are closed (never the one that is shown). Result tabs are kept in memory only: they do not come back when you reopen kisui-terminal.
- **Two or more statements.** When the selection holds two or more statements, they run one after another, from the top, each as a request of its own (the same as running them one at a time). The first statement goes where a single statement would (it replaces the result tab that is shown, or goes to a new tab with `Cmd+Option+Enter` / `Ctrl+Shift+Enter`), and each of the others gets a new result tab, to the right of the one before it. The tab that is shown follows the statement that is running (unless you went to another tab while they run). When a statement fails, the ones after it are not run, and its tab shows the error (in red). `Esc` in the SQL box cancels the statement that is running and does not run the rest. **The statements are not one transaction:** each is committed by itself as it runs, so when a later statement fails, what the earlier ones changed stays. Writing `BEGIN` and `COMMIT` among them does not help either, because each statement logs in by itself (below).
- PostgreSQL's `COPY` is refused: there is nowhere to send its data to or take it from. `COPY` to or from a file of the server is refused with it.
- Each statement logs in by itself and logs out when it is done. What a statement leaves in a session (`SET`, `USE`, a temporary table) is gone for the next one, and a transaction cannot span statements. Without `read-only` (and with the level `"free"`), each statement is committed by itself.
- **The default schema of a connection.** Click the default schema above the schema tree of the sidebar (or press `s` in the tree) and a list of the schemas opens in its place to make one the default schema of the connection: type to filter, `↓` `↑` or Ctrl+J / Ctrl+K choose, `Enter` or a click makes it the default, `Esc` closes the list without changing it. Until you choose one, the list shows the default schema of the database (`current_schema()` in PostgreSQL, the database of the connection in MySQL); choosing that one again, or "(default of the database)" (listed when the database has no default schema among the listed ones, or its `kisui serve` is older and does not tell it), goes back to it. Reloading the tree (`r` in the database tab window) also goes back to it when the schema you chose is no longer in the list. A machine whose `kisui serve` is older and does not know default schemas would ignore the choice, so the window does not let you choose one there (and when a schema was chosen before `kisui serve` became an older one, the window drops the choice and says so when it reads the tree; if you run SQL before that, it is not run). A table, view or function you name without a schema is then looked for in that schema first: before every statement of the tab, `kisui serve` puts it at the head of the `search_path` (PostgreSQL; the `search_path` of the login stays after it, so the functions of an extension in `public` are still found) or runs `USE` with it (MySQL). It is set again for each statement because each statement logs in by itself (above), so a `SET search_path` or a `USE` of your own still lasts for that statement only. The pages and sortings of a result keep the schema the statement first ran with. The choice is kept for the connection (the machine, the name of the connection and its variant), in the window's own storage: every database tab of the same connection uses it, tabs of other connections are not affected, and it is still there when you reopen kisui-terminal. In MySQL, a database that is not there (or that you may not use) makes each statement fail until you choose another one; in PostgreSQL a schema that is not there is no error, the names are just not found in it.
- **The schemas the tree shows.** The schema tree lists the tables and views of the default schema only (the one the list above it shows). The box that filters the tables by name looks in the default schema first, then lists the tables of the other schemas that match under "Other schemas", as `schema.table` (choosing one shows its rows without changing the default schema). When there is no default schema to show (MySQL with no database in the connection, or an older `kisui serve` that does not tell the default schema of the database, until you choose one), the tree lists every schema with its tables under it.
- A result holds up to 1000 rows (the window can ask for up to 10000) and 8 MiB; one value holds up to 1 MiB. The result says when it was cut.
- **Pages.** When a `SELECT` (or `WITH ... SELECT`) gives more rows than one page (1000), the result shows "Previous" and "Next" under the table (or press `f` and `b` in the database tab window, the leader then `a`; the summary says which rows of the statement you see). A session is not kept between statements, so each page runs the statement again, wrapped: `SELECT * FROM (<your statement>) AS q LIMIT 1001 OFFSET <rows before the page>`. The first page is your statement as it is. The database skips the rows before a page (it still reads them, so a page far into a large result takes longer), and only the rows of the page come to the window. Changing pages is not written to the history.
  - If the data changes between pages, rows can move: a row may show on two pages or on none. Without an `ORDER BY` the database may also give the rows in another order each time, so add an `ORDER BY` (on columns that tell the rows apart) when the order matters.
  - Other statements (`SHOW`, `EXPLAIN`, `INSERT ... RETURNING`, a `WITH` whose part writes, and so on) are not paged: you see the first rows only, as before. MySQL cannot wrap a result with two columns of the same name (a `SELECT *` of a join often has them; names are compared without case), so such a result is not paged either; give the columns names of their own with `AS` to page it.
  - Export (`e` in the database tab window) and copying take the page you see.
- **Choosing a table: the preview tab.** Choosing a table or view in the schema tree runs `SELECT * ... LIMIT 100` on it into a *preview tab* of the results. The SQL box is not changed, so a draft you were writing stays. There is only one preview tab (shown in italics with a dashed border, with the name of the table as its title; the full statement is in its tooltip): choosing another table replaces it, like the preview tab of an editor. The preview tab becomes an ordinary tab, which stays, when you sort it by a column, change its page, double-click its tab, or run from the SQL box over it (`Cmd+Enter` / `Ctrl+Enter` with the preview tab shown). After that, choosing a table opens a new preview tab. Closing the preview tab, or the tab limit closing it, also ends it.
- **The structure of a table.** Choose a table (or a view) in the schema tree of the sidebar (it lists the schemas and tables only; the columns are here), and a switch between "Data" and "Structure" shows above the result, in the result tab that shows the table (choosing a table runs its `SELECT` into the preview tab of the results, below; a result tab that was not opened this way has no switch). "Data" is the result of the SQL, as before. "Structure" (click it, or press `s` in the database tab window to switch) shows the columns of the table (name, type, whether it takes NULL, default), its indexes (the primary key first; the columns, primary key or unique, and the method such as `btree`) and its foreign keys (the columns, the table and columns they point to, and what happens on update and on delete). `kisui serve` reads them from the catalog of the database (`pg_catalog` in PostgreSQL, `information_schema` in MySQL) when you first show them; `r` in the database tab window reads them again. They are read whatever the permission lets you run, like the schema tree. Choosing another table keeps the side you are on, so you can go through the structures of several tables in the tree; running SQL from the SQL box goes back to "Data" (and, when it overwrites the tab of a table, the tab is no longer that table's: the switch goes away, because the result is no longer the table's rows). A machine whose `kisui serve` is older cannot show the structure and says so.
- **Sorting.** Click a column heading of the result, or select a cell of the column and press `s` (the table must have focus), to sort the rows by that column: each press goes ascending (▲), descending (▼), then back to no sorting. The database does the sorting, so all the rows are sorted, not only the page you see. The statement is run again wrapped like a page, with an `ORDER BY` of the position of the column: `SELECT * FROM (<your statement>) AS q ORDER BY <position> [DESC] LIMIT 1001 OFFSET 0`. The column is given by its position, so a column needs no quoting and (in PostgreSQL) two columns of the same name cannot be mixed up. MySQL refuses a derived table with two columns of the same name, so there a result with such columns (a `SELECT *` of a join often has them; names are compared without case) cannot be sorted, and the headings do nothing; give the columns names of their own with `AS`. Sorting starts again from the first page, and the pages after it keep the order. Sorting is for the statements that are paged (`SELECT` and `WITH ... SELECT`); for others, the headings do nothing. Rows that are equal in the sorted column may come in another order from page to page; sort again by `ORDER BY` of your own statement on columns that tell the rows apart when that matters. A sorting is not written to the history, and a new run of the SQL box starts with no sorting. Export (`e` in the database tab window) and copying take the rows you see, in the sorted order.
- In the result table, click a cell to select it, and extend the selection with Shift+click or by dragging. `Cmd+C` (macOS) or `Ctrl+C` copies the selected cells (the table must have focus). One cell is copied as its value; two or more are copied as TSV (tab between columns, a line break between rows; NULL is empty, and a value with a tab, a quote or a line break is quoted, as in the export). The header row is not copied.
- A statement can be cancelled; the database is told to stop it.
- TLS is what the key `tls` of the connection says (above): by default, TLS when the database offers it, without checking the certificate (what `psql` and `mysql` do by default). For a database over the network, `tls = "verify"` makes sure you are talking to the database and not to someone in the middle who could take the password. A certificate that is not trusted, or not for the `host`, makes the login fail. The file of `tls-ca` is read at each login, so a new one is used without restarting `kisui serve`. A certificate of your own for the database to check (a client certificate) cannot be set in the settings yet.

## History

`kisui serve` keeps the statements it runs, for each connection apart, and for each variant of a connection apart: the statement, when it was sent, whether it worked, and whether a coding agent ran it (`kisui db query`; the history window marks those "agent"). The rows of the result are not kept. A statement for one connection never shows up in the history of another, so the SQL of production and of development do not mix.

- The history is on the machine where `kisui serve` runs, in `db-history/` beside `serve.log` (`~/.local/state/shijimi-editor/db-history/`, or under `$XDG_STATE_HOME`). It stays when `kisui serve` starts again. The files are readable by you only, but the statements are kept as they are: a password written in a statement (`ALTER USER ... PASSWORD`) is kept with it.
- A connection is told by its `name`, and a variant by the `name` of its connection and its own. Renaming a connection or a variant starts a new history; pointing a name at another database keeps the old one. Adding variants to a connection starts a new history for each variant (the history from before stays in its file, and shows again if you remove the variants).
- Each connection (each variant) keeps its newest 1000 statements (and up to 4 MiB). A statement longer than 64 KiB is not kept.
- A statement that never ran, because the login failed, is not kept. Listing the schemas and tables is not kept either.
- To forget the history, delete the folder or the files in it; this works while `kisui serve` runs too.
