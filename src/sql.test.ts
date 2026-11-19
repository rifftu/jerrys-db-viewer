import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteIdent, quoteLiteral, sqlValue, titleFromSql } from "./sql.ts";

test("titleFromSql names the first table, else the start of the SQL", () => {
  const t = (sql: string) => titleFromSql(sql).title;
  assert.equal(t(`select * from users where id = 1`), "users");
  assert.equal(t(`SELECT * FROM "public"."Order Items" LIMIT 420`), "Order Items");
  assert.equal(t(`select 'from nope' -- from nope\n from app.rooms r join users u on true`), "rooms");
  assert.equal(t(`update accounts set a = 1`), "accounts");
  assert.equal(t(`insert into logs (a) values (1)`), "logs");
  assert.equal(t(`delete from only old_rows`), "old_rows");
  assert.equal(t(`select * from generate_series(1, 3) g join users u on true`), "users");
  assert.equal(t(`SELECT * FROM (select * from users limit 5) AS t LEFT JOIN "public"."orgs" AS j ON true`), "users");
  assert.deepEqual(titleFromSql(`  select   now(),\n 1 + 1 as a_rather_long_alias`), { title: "select now(), 1 + 1 as a", fromTable: false });
  assert.equal(titleFromSql("select * from users").fromTable, true);
});

test("identifiers are double-quoted with inner quotes doubled", () => {
  assert.equal(quoteIdent("org_id"), '"org_id"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test("literals are single-quoted with inner quotes doubled", () => {
  assert.equal(quoteLiteral("acme"), "'acme'");
  assert.equal(quoteLiteral("it's"), "'it''s'");
});

test("NULL cells become bare NULL", () => {
  assert.equal(sqlValue(null), "NULL");
  assert.equal(sqlValue("NULL"), "'NULL'");
  assert.equal(sqlValue(""), "''");
});
