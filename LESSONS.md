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
- Connection config uses explicit TOML fields rather than a libpq URL/key=value string inside a TOML string; that read as nonstandard.
- libpq `sslmode=require` encrypts without verifying the certificate, but native-tls verifies by default. Map `prefer`/`require` to `danger_accept_invalid_certs` or cloud DBs fail to connect.
