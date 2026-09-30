import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteIdent, quoteLiteral, sqlValue } from "./sql.ts";

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
