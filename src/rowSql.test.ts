import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteSql, editRowSql, insertSql, pickKey, placeholder, updateSql, type ColumnMeta, type TableMeta } from "./rowSql.ts";

const col = (name: string, o: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  category: "S",
  typname: "text",
  displayType: "text",
  notNull: false,
  hasDefault: false,
  generated: false,
  identity: false,
  ...o,
});
const t = { schema: "public", table: "users" };
const columns = ["id", "org", "email", "note"];
const row = ["5", "7", "a@b.c", null];

test("pickKey prefers the first usable key", () => {
  const meta: TableMeta = { columns: [], keys: [["id"], ["email"]] };
  assert.deepEqual(pickKey(meta, columns, row), ["id"]);
  assert.deepEqual(pickKey(meta, ["email", "note"], ["x", null]), ["email"], "skips keys not in the result");
  assert.equal(pickKey({ columns: [], keys: [["note"]] }, columns, row), null, "skips keys NULL in the row");
  assert.deepEqual(pickKey({ columns: [], keys: [["note"]] }, columns), ["note"], "without a row only presence counts");
  assert.equal(pickKey({ columns: [], keys: [] }, columns, row), null);
});

test("deleteSql with single and composite keys", () => {
  assert.equal(deleteSql(t, ["id"], columns, row), `DELETE FROM "public"."users" WHERE "id" = '5';`);
  assert.equal(deleteSql(t, ["id", "org"], columns, row), `DELETE FROM "public"."users" WHERE "id" = '5' AND "org" = '7';`);
});

test("updateSql selects the current value inside the quotes", () => {
  const u = updateSql(t, ["id"], columns, ["5", "7", "it's", null], 2);
  assert.equal(u.sql, `UPDATE "public"."users" SET "email" = 'it''s' WHERE "id" = '5';`);
  assert.equal(u.sql.slice(u.selStart, u.selEnd), "it''s");
  const n = updateSql(t, ["id"], columns, row, 3);
  assert.equal(n.sql, `UPDATE "public"."users" SET "note" = NULL WHERE "id" = '5';`);
  assert.equal(n.sql.slice(n.selStart, n.selEnd), "NULL");
  const e = updateSql(t, ["id"], columns, ["5", "7", "", null], 2);
  assert.equal(e.selStart, e.selEnd, "empty string: cursor between the quotes");
  assert.equal(e.sql[e.selStart - 1] + e.sql[e.selEnd], "''");
});

test("placeholders", () => {
  assert.equal(placeholder(col("id", { notNull: true, hasDefault: true })), "DEFAULT");
  assert.equal(placeholder(col("id", { notNull: true, identity: true })), "DEFAULT");
  assert.equal(placeholder(col("n")), "NULL");
  assert.equal(placeholder(col("s", { notNull: true })), "''");
  assert.equal(placeholder(col("b", { notNull: true, category: "B", typname: "bool" })), "false");
  assert.equal(placeholder(col("i", { notNull: true, category: "N", typname: "int4" })), "0");
  assert.equal(placeholder(col("a", { notNull: true, category: "A", typname: "_text" })), "'{}'");
  assert.equal(placeholder(col("d", { notNull: true, category: "D", typname: "timestamptz" })), "'now'");
  assert.equal(placeholder(col("j", { notNull: true, category: "U", typname: "jsonb" })), "'{}'");
  assert.equal(placeholder(col("u", { notNull: true, category: "U", typname: "uuid" })), "gen_random_uuid()");
  assert.equal(placeholder(col("e", { notNull: true, category: "E", typname: "mood" })), "NULL");
});

test("insertSql: one annotated value per line, generated columns skipped", () => {
  const meta: TableMeta = {
    columns: [
      col("id", { notNull: true, hasDefault: true, displayType: "integer", category: "N" }),
      col("email", { notNull: true, displayType: "character varying(255)" }),
      col("upper", { generated: true }),
      col("note"),
    ],
    keys: [["id"]],
  };
  assert.equal(
    insertSql(t, meta),
    [
      `INSERT INTO "public"."users" ("id", "email", "note")`,
      `VALUES (`,
      `  DEFAULT,  -- id  integer, default`,
      `  '',       -- email  character varying(255), not null`,
      `  NULL      -- note  text, nullable`,
      `);`,
    ].join("\n"),
  );
});

test("editRowSql: current values, key/generated/identity/computed columns left out", () => {
  const meta: TableMeta = {
    columns: [
      col("id", { notNull: true, identity: true, displayType: "integer" }),
      col("email", { notNull: true }),
      col("note"),
      col("up", { generated: true }),
      col("n", { displayType: "integer" }),
    ],
    keys: [["id"]],
  };
  // e.g. SELECT id, email, note, up, n, lower(email), email FROM ...
  const cols = ["id", "email", "note", "up", "n", null, "email"];
  const r = ["5", "it's", null, "IT'S", "3", "x", "it's"];
  assert.equal(
    editRowSql(t, meta, ["id"], cols, r),
    [
      `UPDATE "public"."users" SET`,
      `  "email" = 'it''s',  -- text, not null`,
      `  "note" = NULL,      -- text, nullable`,
      `  "n" = '3'           -- integer, nullable`,
      `WHERE "id" = '5';`,
    ].join("\n"),
  );
  assert.equal(editRowSql(t, meta, ["id"], ["id", "up"], ["5", "X"]), null, "nothing editable");
});

test("comments never contain line breaks", () => {
  const meta: TableMeta = { columns: [col("we\nird")], keys: [] };
  assert.ok(insertSql(t, meta).includes("-- we ird  text, nullable"));
});

test("result columns may be aliased (mapped to real names) or computed (null)", () => {
  // e.g. SELECT "id", "email" AS e, lower(email) FROM users
  const mapped = ["id", "email", null];
  const r = ["5", "x@y", "x@y"];
  assert.deepEqual(pickKey({ columns: [], keys: [["id"]] }, mapped, r), ["id"]);
  assert.equal(updateSql(t, ["id"], mapped, r, 1).sql, `UPDATE "public"."users" SET "email" = 'x@y' WHERE "id" = '5';`);
  assert.equal(pickKey({ columns: [], keys: [["id"]] }, [null, "email"], ["5", "x"]), null, "key column computed -> unusable");
});
