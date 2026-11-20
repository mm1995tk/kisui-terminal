# Database connections

`kisui serve` can connect to MySQL and PostgreSQL and run SQL for the window. This page is about the settings: which databases, and where their passwords come from.

You use these connections in a database tab of the window (the leader, then `d` `n`; see the README). This page is about the part under it: the settings, and the requests `kisui serve` answers (`db.connections`, `db.query`, `db.cancel`, `db.schema`, `db.history`; see [design/gui-protocol.md](design/gui-protocol.md)).

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

| Key | Meaning |
| --- | --- |
| `name` | What you call the connection. Required, up to 100 characters, and no two connections of a machine have the same name. |
| `kind` | `"postgres"` or `"mysql"`. Required. |
| `host` | A host name or an address. `"localhost"` when left out. A value that starts with `/` is a Unix socket: the folder of the socket for PostgreSQL (`/run/postgresql`), the socket file for MySQL (`/run/mysqld/mysqld.sock`). |
| `port` | `5432` (PostgreSQL) or `3306` (MySQL) when left out. |
| `user` | Who logs in. Required. |
| `database` | The database to open. When left out, PostgreSQL opens the one named like the user, and MySQL selects none. |
| `read-only` | `true` makes every statement run in a read-only transaction: the database refuses anything that writes. `false` when left out. |

- A list in `config.local.toml` replaces the list of `config.toml` as a whole.
- The settings are read each time the list is asked for, so a connection you add shows without restarting `kisui serve`.
- A mistake in a connection does not stop `kisui serve`. That connection is left out of the list, and the mistake is reported with it. A key that is not in the table above is a mistake too, so that a misspelt `read-only` does not give a connection that can write.
- `read-only` is there to prevent accidents, not to replace rights. For a database nobody may write to, log in as a user that can only read.

## Passwords

A password is never written in `config.toml`; a `password` key is reported as a mistake. `kisui serve` looks for the password of a connection in this order, on the machine where it runs:

1. **The keychain (macOS).** A generic password with the service `kisui-terminal-db` and the name of the connection as the account. Add one with:

   ```sh
   security add-generic-password -s kisui-terminal-db -a "shop (production)" -w
   ```

   Use a password of ASCII characters here (`security` cannot hand others back). In a login over ssh the keychain is usually locked; then the next places are used. On Linux there is no keychain step.

2. **`~/.pgpass` (PostgreSQL) or `~/.my.cnf` (MySQL)**, the files the clients of the databases read.
   - `~/.pgpass` (or the file `PGPASSFILE` names): lines of `host:port:database:user:password`, where `*` matches anything. A connection over a Unix socket matches the host `localhost`.
   - `~/.my.cnf`: the `password` of the `[client]` group. When `[client]` also has `user`, `host` or `port`, the password is used only for a connection with the same ones.

3. **The password you type.** When neither place has one, the window asks. `kisui serve` keeps a password that worked in memory until it stops, so you are asked once; it is not written to any file.

A password found in the keychain or in a file is used before a typed one. When the database refuses it, fix it where it was found.

## What a statement does

- One request runs one statement. Several statements separated by `;` are refused by the database.
- PostgreSQL's `COPY` is refused: there is nowhere to send its data to or take it from. `COPY` to or from a file of the server is refused with it.
- Each statement logs in by itself and logs out when it is done. What a statement leaves in a session (`SET`, `USE`, a temporary table) is gone for the next one, and a transaction cannot span statements. Without `read-only`, each statement is committed by itself.
- A result holds up to 1000 rows (the window can ask for up to 10000) and 8 MiB; one value holds up to 1 MiB. The result says when it was cut.
- **Pages.** When a `SELECT` (or `WITH ... SELECT`) gives more rows than one page (1000), the result shows "Previous" and "Next" under the table (or press `d` `j` and `d` `k` after the leader; the summary says which rows of the statement you see). A session is not kept between statements, so each page runs the statement again, wrapped: `SELECT * FROM (<your statement>) AS q LIMIT 1001 OFFSET <rows before the page>`. The first page is your statement as it is. The database skips the rows before a page (it still reads them, so a page far into a large result takes longer), and only the rows of the page come to the window. Changing pages is not written to the history.
  - If the data changes between pages, rows can move: a row may show on two pages or on none. Without an `ORDER BY` the database may also give the rows in another order each time, so add an `ORDER BY` (on columns that tell the rows apart) when the order matters.
  - Other statements (`SHOW`, `EXPLAIN`, `INSERT ... RETURNING`, a `WITH` whose part writes, and so on) are not paged: you see the first rows only, as before. MySQL cannot wrap a result with two columns of the same name (a `SELECT *` of a join often has them; names are compared without case), so such a result is not paged either; give the columns names of their own with `AS` to page it.
  - Export (`d` `e`) and copying take the page you see.
- In the result table, click a cell to select it, and extend the selection with Shift+click or by dragging. `Cmd+C` (macOS) or `Ctrl+C` copies the selected cells (the table must have focus). One cell is copied as its value; two or more are copied as TSV (tab between columns, a line break between rows; NULL is empty, and a value with a tab, a quote or a line break is quoted, as in the export). The header row is not copied.
- A statement can be cancelled; the database is told to stop it.
- When the database offers TLS it is used, without checking the certificate (what `psql` and `mysql` do by default).

## History

`kisui serve` keeps the statements it runs, for each connection apart: the statement, when it was sent, and whether it worked. The rows of the result are not kept. A statement for one connection never shows up in the history of another, so the SQL of production and of development do not mix.

- The history is on the machine where `kisui serve` runs, in `db-history/` beside `serve.log` (`~/.local/state/shijimi-editor/db-history/`, or under `$XDG_STATE_HOME`). It stays when `kisui serve` starts again. The files are readable by you only, but the statements are kept as they are: a password written in a statement (`ALTER USER ... PASSWORD`) is kept with it.
- A connection is told by its `name`. Renaming a connection starts a new history; pointing a name at another database keeps the old one.
- Each connection keeps its newest 1000 statements (and up to 4 MiB). A statement longer than 64 KiB is not kept.
- A statement that never ran, because the login failed, is not kept. Listing the schemas and tables is not kept either.
- To forget the history, delete the folder or the files in it; this works while `kisui serve` runs too.
