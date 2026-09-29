import { test } from "node:test";
import assert from "node:assert/strict";
import { tabLabels, type LabelInput } from "./tabLabels.ts";

const at = (h: number, m: number, s: number) => new Date(2026, 8, 29, h, m, s).getTime();
let id = 0;
const tab = (title: string, conn: string, db: string, lastRunAt: number | null, fromTable = true): LabelInput => ({
  id: ++id,
  title,
  fromTable,
  conn,
  db,
  lastRunAt,
});
const labelsOf = (tabs: LabelInput[]) => {
  const m = tabLabels(tabs);
  return tabs.map((t) => m.get(t.id));
};

test("unique titles are left alone", () => {
  assert.deepEqual(labelsOf([tab("users", "a", "app", at(1, 2, 3)), tab("orders", "a", "app", at(1, 2, 3))]), [
    "users",
    "orders",
  ]);
});

test("different connections: 8 chars from the first difference", () => {
  // pg_dev:app:... vs pg_staging:app:... differ at index 3.
  assert.deepEqual(
    labelsOf([tab("users", "pg_dev", "app", at(14, 5, 7)), tab("users", "pg_staging", "app", at(14, 5, 7))]),
    ["users (dev:app:)", "users (staging:)"],
  );
});

test("difference too close to the end falls back to the last 8 chars", () => {
  assert.deepEqual(labelsOf([tab("users", "a", "app", at(14, 5, 7)), tab("users", "a", "app", at(14, 5, 9))]), [
    "users (14:05:07)",
    "users (14:05:09)",
  ]);
});

test("identical full strings use the last 8 chars", () => {
  assert.deepEqual(labelsOf([tab("users", "a", "app", at(14, 5, 7)), tab("users", "a", "app", at(14, 5, 7))]), [
    "users (14:05:07)",
    "users (14:05:07)",
  ]);
});

test("three-way group and a partial timestamp", () => {
  // Same conn/db; minutes differ first: "a:app:09/29/14:0" is shared, then 5/6.
  assert.deepEqual(
    labelsOf([
      tab("users", "a", "app", at(14, 5, 7)),
      tab("users", "a", "app", at(14, 6, 7)),
      tab("users", "a", "app", at(14, 5, 8)),
    ]),
    ["users (14:05:07)", "users (14:06:07)", "users (14:05:08)"],
  );
  // Hours differ: diff at the 'hh' tens digit leaves room for 8 chars.
  assert.deepEqual(labelsOf([tab("users", "a", "app", at(9, 5, 7)), tab("users", "a", "app", at(19, 5, 7))]), [
    "users (09:05:07)",
    "users (19:05:07)",
  ]);
});

test("different dbs on the same connection", () => {
  assert.deepEqual(
    labelsOf([tab("users", "pg", "analytics", at(1, 2, 3)), tab("users", "pg", "app", at(1, 2, 3))]),
    ["users (nalytics)", "users (pp:09/29)"],
  );
});

test("duplicate New tab tabs are not disambiguated", () => {
  assert.deepEqual(
    labelsOf([tab("New tab", "a", "app", null, false), tab("New tab", "a", "app", null, false)]),
    ["New tab", "New tab"],
  );
});
