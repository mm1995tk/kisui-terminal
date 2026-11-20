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
| `variants` | The environments of the connection (below). Left out, the connection is one database. |

- A list in `config.local.toml` replaces the list of `config.toml` as a whole.
- The settings are read each time the list is asked for, so a connection you add shows without restarting `kisui serve`.
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

| Key of a variant | Meaning |
| --- | --- |
| `name` | What you call the variant. Required, up to 100 characters, without a `/`, and no two variants of a connection have the same name. |
| `host`, `port`, `user`, `database`, `read-only` | As in the table above, for this variant. |

- A variant takes the keys it does not write from its connection, and the defaults of the table above when the connection does not write them either. Above, `local` is `app@localhost:5432/shop`, and `prod` is `reader@db.example.com:5432/shop`, read-only. `read-only = true` on the connection makes every variant read-only, except one that writes `read-only = false`.
- `kind` is written on the connection only: the variants of a connection are the same kind of database.
- `user` may be written on the connection, on a variant, or on both, as long as every variant ends up with one.
- You choose the variant when you open a database tab: the window lists each variant as its own row, `shop (local)`, `shop (dev)`, `shop (prod)`, in the order written. A tab stays on the variant it was opened with.
- A connection with variants is not a database by itself: only its variants are listed.
- A mistake in one variant leaves the whole connection out of the list (all its variants), and is reported with it.
- When you add variants to a connection you already use, its database tabs that are open stop working (they name no variant): close them and open the variant you want. The history and the keychain item of the connection are not carried over to a variant (see below).

## Passwords

A password is never written in `config.toml`; a `password` key is reported as a mistake. `kisui serve` looks for the password of a connection in this order, on the machine where it runs:

1. **The keychain (macOS).** A generic password with the service `kisui-terminal-db` and the name of the connection as the account. Add one with:

   ```sh
   security add-generic-password -s kisui-terminal-db -a "shop (production)" -w
   ```

   Each variant of a connection has an item of its own. Its account is the name of the connection, a slash and the name of the variant (`-a "shop/prod"`). The item of one variant is never tried for another. The name of a variant cannot have a `/`, so two variants never share an item. (A connection without variants named `shop/prod` would share that item, so do not name one like that.)

   Use a password of ASCII characters here (`security` cannot hand others back). In a login over ssh the keychain is usually locked; then the next places are used. On Linux there is no keychain step.

2. **`~/.pgpass` (PostgreSQL) or `~/.my.cnf` (MySQL)**, the files the clients of the databases read.
   - `~/.pgpass` (or the file `PGPASSFILE` names): lines of `host:port:database:user:password`, where `*` matches anything. A connection over a Unix socket matches the host `localhost`.
   - `~/.my.cnf`: the `password` of the `[client]` group. When `[client]` also has `user`, `host` or `port`, the password is used only for a connection with the same ones.

3. **The password you type.** When neither place has one, the window asks. `kisui serve` keeps a password that worked in memory until it stops, so you are asked once; it is not written to any file. Each variant is asked for by itself: a password typed for one variant is not sent to another.

A password found in the keychain or in a file is used before a typed one. When the database refuses it, fix it where it was found.

## What a statement does

- One request runs one statement. Several statements separated by `;` are refused by the database.
- PostgreSQL's `COPY` is refused: there is nowhere to send its data to or take it from. `COPY` to or from a file of the server is refused with it.
- Each statement logs in by itself and logs out when it is done. What a statement leaves in a session (`SET`, `USE`, a temporary table) is gone for the next one, and a transaction cannot span statements. Without `read-only`, each statement is committed by itself.
- A result holds up to 1000 rows (the window can ask for up to 10000) and 8 MiB; one value holds up to 1 MiB. The result says when it was cut.
- In the result table, click a cell to select it, and extend the selection with Shift+click or by dragging. `Cmd+C` (macOS) or `Ctrl+C` copies the selected cells (the table must have focus). One cell is copied as its value; two or more are copied as TSV (tab between columns, a line break between rows; NULL is empty, and a value with a tab, a quote or a line break is quoted, as in the export). The header row is not copied.
- A statement can be cancelled; the database is told to stop it.
- When the database offers TLS it is used, without checking the certificate (what `psql` and `mysql` do by default).

## History

`kisui serve` keeps the statements it runs, for each connection apart, and for each variant of a connection apart: the statement, when it was sent, and whether it worked. The rows of the result are not kept. A statement for one connection never shows up in the history of another, so the SQL of production and of development do not mix.

- The history is on the machine where `kisui serve` runs, in `db-history/` beside `serve.log` (`~/.local/state/shijimi-editor/db-history/`, or under `$XDG_STATE_HOME`). It stays when `kisui serve` starts again. The files are readable by you only, but the statements are kept as they are: a password written in a statement (`ALTER USER ... PASSWORD`) is kept with it.
- A connection is told by its `name`, and a variant by the `name` of its connection and its own. Renaming a connection or a variant starts a new history; pointing a name at another database keeps the old one. Adding variants to a connection starts a new history for each variant (the history from before stays in its file, and shows again if you remove the variants).
- Each connection (each variant) keeps its newest 1000 statements (and up to 4 MiB). A statement longer than 64 KiB is not kept.
- A statement that never ran, because the login failed, is not kept. Listing the schemas and tables is not kept either.
- To forget the history, delete the folder or the files in it; this works while `kisui serve` runs too.
