# jerrys-db-viewer

A deliberately tiny Postgres viewer: Tauri 2 + React + tokio-postgres.

- Pick a connection, see its tables, click a table to `SELECT * … LIMIT 1000`.
- Type SQL, press **Enter** to run it (**Shift+Enter** for a newline).
- Results are a plain, non-interactive table. All values are shown as text (simple query protocol).

## Connections

Connections are config-as-code in a TOML file, see [`connections.example.toml`](connections.example.toml).

The app reads `$DB_VIEWER_CONFIG` if set, otherwise `~/.config/jerrys-db-viewer/connections.toml`.

Passwords go in the `password` field of each connection. Keep the config file outside the repo.

## Development

Needs Node and Rust (`mise install` picks up Rust from `mise.toml`).

```sh
npm install
npm run tauri dev      # run the app
npm run tauri build    # build DB Viewer.app
```
