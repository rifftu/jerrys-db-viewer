# Lessons

- Query results use tokio-postgres `simple_query`: every value arrives as text, so no per-type decoding. `RowDescription` still gives column names for empty results.
- TypeScript 7 errors on side-effect CSS imports (`TS2882`) unless `vite/client` types are referenced (`src/vite-env.d.ts`).
- `cargo add` fails on a crate whose `[lib]` points at a missing `src/lib.rs`, so write the file first.
- Rust comes from `mise.toml`; outside a mise-activated shell use `mise exec -- cargo ...`.
- The backend integration test is skipped unless `DB_VIEWER_TEST_PORT` points at a scratch database, e.g.
  `docker run -d --rm --name dbviewer-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine`
  then `DB_VIEWER_TEST_PORT=55432 cargo test` in `src-tauri`.
- Frontend unit tests use Node's built-in runner, no deps: `npm test` (Node 24 runs `.ts` directly; imports need the `.ts` extension, so `*.test.ts` is excluded from `tsc`). `node --test` needs a glob, not a directory.
- Connection config uses explicit TOML fields rather than a libpq URL/key=value string inside a TOML string; that read as nonstandard.
- libpq `sslmode=require` encrypts without verifying the certificate, but native-tls verifies by default. Map `prefer`/`require` to `danger_accept_invalid_certs` or cloud DBs fail to connect.
