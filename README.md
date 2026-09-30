# jerrys-db-viewer

A deliberately tiny Postgres viewer: Tauri 2 + React + tokio-postgres.

- Pick a connection, then a database (defaults to the configured `dbname`), see its tables.
  Double-click a table to `SELECT * … LIMIT 420` in the current tab, ⌘-click to open it in a new tab.
- Tabs (`+` / `×`) each keep their own connection, database, SQL and results.
- Drag a column header's right edge to resize it; double-click the header to shrink it to ~3 characters,
  double-click its right edge to restore the default width. Widths reset on re-query.
- Each tab has a bottom panel (drag its top edge to resize; click the open tab to collapse):
  - **info**: metadata for every table the tab's last query touches (found via `EXPLAIN`, so nothing runs).
  - **edit**: write SQL, **review** shows exactly what will run and on which connection/database, **execute** runs it.
- Click a cell to select it (its row and column get a lighter tint; colors follow the system selection color).
- With the SQL box focused, ⌥-click a header to insert `"column"`, or a cell to insert `'value'` (or `NULL`), at the cursor.
- Press and hold a cell for 500ms to open its full value in a dialog (copy / close).
- Foreign-key values are underlined; ⌘-click one to open the referenced row(s) in a new tab.
  FKs are cached per database when the sidebar lists its tables (re-select the database to refresh).
- Type SQL, press **Enter** to run it (**Shift+Enter** for a newline).
- Results are a plain, non-interactive table. All values are shown as text (simple query protocol).

## Connections

Connections are config-as-code in a TOML file, see [`connections.example.toml`](connections.example.toml).
Each entry has the same fields as a `pg_service.conf` service (`host`, `port`, `user`, `dbname`,
`password`, `sslmode`), with libpq's defaults and `sslmode` meanings.

The app reads `$DB_VIEWER_CONFIG` if set, otherwise `~/.config/jerrys-db-viewer/connections.toml`.

Passwords go in the `password` field of each connection. Keep the config file outside the repo.

## Development

Needs Node and Rust (`mise install` picks up Rust from `mise.toml`).

```sh
npm install
npm run tauri dev      # run the app
npm run tauri build    # build DB Viewer.app
```
