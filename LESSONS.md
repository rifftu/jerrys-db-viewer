# Lessons

- Query results use tokio-postgres `simple_query`: every value arrives as text, so no per-type decoding. `RowDescription` still gives column names for empty results.
- TypeScript 7 errors on side-effect CSS imports (`TS2882`) unless `vite/client` types are referenced (`src/vite-env.d.ts`).
- `cargo add` fails on a crate whose `[lib]` points at a missing `src/lib.rs`, so write the file first.
- Rust comes from `mise.toml`; outside a mise-activated shell use `mise exec -- cargo ...`.
- The backend integration test is skipped unless `DB_VIEWER_TEST_PORT` points at a scratch database, e.g.
  `docker run -d --rm --name dbviewer-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine`
  then `DB_VIEWER_TEST_PORT=55432 cargo test` in `src-tauri`.
- Frontend unit tests use Node's built-in runner, no deps: `npm test` (Node 24 runs `.ts` directly; imports need the `.ts` extension, so `*.test.ts` is excluded from `tsc`). `node --test` needs a glob, not a directory.
- `simple_query`'s `SimpleColumn` exposes only the name, so FK links use `client.prepare(sql)` (describe only) for each column's table oid/attnum. Issued concurrently with the query on the same client it's pipelined: measured at 100ms RTT, query alone 103ms vs with describe 103ms. The first describe returning a custom type (enum etc.) on a connection costs ~5 RTTs of tokio-postgres type lookups (~520ms at 100ms RTT); rows aren't delayed, only the underline.
- Test latency locally with the asyncio delaying proxy approach (chunk-delay, order-preserving) in front of the scratch Postgres.
- Vite `server.watch.ignored` globs like `**/.claude/**` also match the root itself when the server runs inside `.claude/worktrees/…`, so it silently serves stale files. Anchor ignore globs to the config's own directory.
- Column resizing: snapshot auto widths on first interaction, then `table-layout: fixed` + `<colgroup>`; memoize `<tbody>` so drags don't re-render rows.
- Pane divider drag writes a CSS variable (`--sidebar-w`) on `.app` directly, bypassing React state, so dragging commits nothing.
- To count React commits in a browser test, install a stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` with `onCommitFiberRoot` via chrome-devtools `navigate_page` `initScript` (runs before app scripts; also a clean place for the Tauri `invoke` mock).
- Text overflow is `clip` app-wide (user preference), not `ellipsis`.
- Result-cell interactions go through delegated listeners on `<table>` and `cellAt()` in `ResultTable.tsx` (row/col via `sectionRowIndex`/`cellIndex`); add new cell features there, not as per-cell handlers. Revisit if rows get virtualized, reordered or hidden.
- To act on a click without stealing focus from the SQL box, `preventDefault()` the `mousedown` (not `pointerdown`, which doesn't stop the focus change). Insert with `document.execCommand("insertText")` so native undo works and React's onChange fires; fall back to `setRangeText` + manual state update.
- Selected cell: `ResultTable`'s `selected` ref, shown via `data-sel` on the `<td>`, `<tr>` and `<col>` (column tint = `<col>` background, so `<colgroup>` is always rendered). Use `data-*` for DOM-toggled state; React rewrites `className` when a cell's class prop changes (e.g. late FK info).
- Prefer CSS system colors (`Highlight`, via `color-mix`) over hardcoded colors.
- Tables a query touches: `EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON)` (plans, never executes) and collect `Schema` + `Relation Name` from the plan tree. Covers joins/subqueries/DML targets; views appear as base tables; multi-statement SQL and DDL error.
- Modal `<dialog>` is `inset: 0`; use `height: fit-content` (not `auto`) or it stretches to max-height.
- The bottom panel is a child of each tab's pane (state follows the tab); its height is shared via `--bottom-h` on `.main`.
- Row shortcuts (`src/rowSql.ts`, backend `edit_context`): eligible when EXPLAIN shows exactly one relation scan (count duplicates, so self-joins fail) and describe maps result columns to that table by (table oid, attnum), so aliases work and computed columns map to null. Reject if no column maps (views, aggregates). Only fetched after the rows are rendered, so it never delays the table. Keys: PK first, then unique indexes without predicate/expressions, all non-NULL in the row.
- Frontend modules imported by node tests use explicit `.ts` extensions (`allowImportingTsExtensions` in tsconfig).
- After `execCommand("insertText")` the textarea DOM is updated synchronously; set the selection immediately rather than in rAF.
- Connection config uses explicit TOML fields rather than a libpq URL/key=value string inside a TOML string; that read as nonstandard.
- libpq `sslmode=require` encrypts without verifying the certificate, but native-tls verifies by default. Map `prefer`/`require` to `danger_accept_invalid_certs` or cloud DBs fail to connect.
- App icon: `npm run tauri icon <1024px.png>` regenerates `src-tauri/icons/`; delete the `ios/` and `android/` folders it adds (macOS-only app). `tauri dev` embeds `icon.icns` via `generate_context!()` and sets it as the Dock icon, but that macro only re-runs when the crate recompiles; `build.rs` emits `rerun-if-changed=icons` so an icon change forces it (otherwise the dev build keeps the old icon while release builds get the new one).
