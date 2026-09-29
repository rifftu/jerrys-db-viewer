# Lessons

- Query results use tokio-postgres `simple_query`: every value arrives as text, so no per-type decoding. `RowDescription` still gives column names for empty results.
- TypeScript 7 errors on side-effect CSS imports (`TS2882`) unless `vite/client` types are referenced (`src/vite-env.d.ts`).
- `cargo add` fails on a crate whose `[lib]` points at a missing `src/lib.rs`, so write the file first.
- Rust comes from `mise.toml`; outside a mise-activated shell use `mise exec -- cargo ...`.
- The backend integration test is skipped unless `DB_VIEWER_TEST_URL` points at a scratch database, e.g.
  `docker run -d --rm --name dbviewer-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine`
  then `DB_VIEWER_TEST_URL=postgres://postgres:test@localhost:55432/postgres cargo test` in `src-tauri`.
