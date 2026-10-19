import { test } from "node:test";
import assert from "node:assert/strict";
import { cellText, detailsJson } from "./cellCopy.ts";

test("cellText shows NULL for null", () => {
  assert.equal(cellText("a@b.c"), "a@b.c");
  assert.equal(cellText(null), "NULL");
  assert.equal(cellText(""), "");
});

test("detailsJson has the requested fields; NULL is null; duplicate columns get suffixes", () => {
  const json = detailsJson({
    columns: ["id", "email", "id", "note"],
    row: ["5", "a@b.c", "7", null],
    col: 1,
    sql: "SELECT u.id, u.email, o.id, u.note FROM users u JOIN orgs o ON o.id = u.org_id",
    ranAt: Date.UTC(2026, 9, 19, 12, 34, 56, 789),
    connection: "pg_dev",
    database: "app",
  });
  assert.deepEqual(JSON.parse(json), {
    selectedFieldColumn: "email",
    selectedFieldValue: "a@b.c",
    selectedRow: { id: "5", email: "a@b.c", "id (2)": "7", note: null },
    query: "SELECT u.id, u.email, o.id, u.note FROM users u JOIN orgs o ON o.id = u.org_id",
    queryTime: "2026-10-19T12:34:56.789Z",
    dbConnection: "pg_dev",
    dbName: "app",
  });
  assert.ok(json.includes('\n  "selectedFieldColumn"'), "pretty-printed");
});
