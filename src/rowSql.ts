import { quoteIdent, quoteLiteral, sqlValue } from "./sql.ts";

export type ColumnMeta = {
  name: string;
  /** pg_type.typcategory: S string, B boolean, N numeric, A array, D date/time, E enum, U user... */
  category: string;
  typname: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  identity: boolean;
};

/** Columns plus unique keys (primary key first; plain unique indexes only). */
export type TableMeta = { columns: ColumnMeta[]; keys: string[][] };

export type TableRef = { schema: string; table: string };

const qualified = (t: TableRef) => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;

/** First key whose columns are all in the result; with a row, also all non-NULL in it. */
export function pickKey(meta: TableMeta, columns: string[], row?: (string | null)[]): string[] | null {
  for (const key of meta.keys) {
    const idx = key.map((k) => columns.indexOf(k));
    if (idx.some((i) => i < 0)) continue;
    if (row && idx.some((i) => row[i] === null)) continue;
    return key;
  }
  return null;
}

function where(key: string[], columns: string[], row: (string | null)[]): string {
  return key.map((k) => `${quoteIdent(k)} = ${sqlValue(row[columns.indexOf(k)])}`).join(" AND ");
}

export function deleteSql(t: TableRef, key: string[], columns: string[], row: (string | null)[]): string {
  return `DELETE FROM ${qualified(t)} WHERE ${where(key, columns, row)};`;
}

/** UPDATE setting one column; selStart/selEnd cover the current value (inside the quotes). */
export function updateSql(
  t: TableRef,
  key: string[],
  columns: string[],
  row: (string | null)[],
  col: number,
): { sql: string; selStart: number; selEnd: number } {
  const prefix = `UPDATE ${qualified(t)} SET ${quoteIdent(columns[col])} = `;
  const v = row[col];
  const value = v === null ? "NULL" : quoteLiteral(v);
  const [selStart, selEnd] = v === null ? [prefix.length, prefix.length + 4] : [prefix.length + 1, prefix.length + value.length - 1];
  return { sql: `${prefix}${value} WHERE ${where(key, columns, row)};`, selStart, selEnd };
}

/** Placeholder for a new row's column: DEFAULT, NULL, or a zero value for NOT NULL columns. */
export function placeholder(c: ColumnMeta): string {
  if (c.hasDefault || c.identity) return "DEFAULT";
  if (!c.notNull) return "NULL";
  if (c.typname === "json" || c.typname === "jsonb") return "'{}'";
  if (c.typname === "uuid") return "gen_random_uuid()";
  switch (c.category) {
    case "S":
      return "''";
    case "B":
      return "false";
    case "N":
      return "0";
    case "A":
      return "'{}'";
    case "D":
      return "'now'";
    default:
      return "NULL"; // e.g. enums: left for the user to fill in (review will catch it)
  }
}

export function insertSql(t: TableRef, meta: TableMeta): string {
  const cols = meta.columns.filter((c) => !c.generated);
  return `INSERT INTO ${qualified(t)} (${cols.map((c) => quoteIdent(c.name)).join(", ")})\nVALUES (${cols.map(placeholder).join(", ")});`;
}
