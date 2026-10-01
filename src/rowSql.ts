import { quoteIdent, quoteLiteral, sqlValue } from "./sql.ts";

export type ColumnMeta = {
  name: string;
  /** pg_type.typcategory: S string, B boolean, N numeric, A array, D date/time, E enum, U user... */
  category: string;
  typname: string;
  /** format_type(), e.g. "character varying(255)". */
  displayType: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  identity: boolean;
};

/** Columns plus unique keys (primary key first; plain unique indexes only). */
export type TableMeta = { columns: ColumnMeta[]; keys: string[][] };

export type TableRef = { schema: string; table: string };

/**
 * Per result column, the table column it reads directly, or null (expressions, aggregates).
 * Aliased columns map to their real names.
 */
export type ResultColumns = (string | null)[];

/** From the backend's edit_context: the single table a query reads, and how results map onto it. */
export type EditContext = TableRef & TableMeta & { resultColumns: ResultColumns };

const qualified = (t: TableRef) => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;

/** First key whose columns are all in the result; with a row, also all non-NULL in it. */
export function pickKey(meta: TableMeta, columns: ResultColumns, row?: (string | null)[]): string[] | null {
  for (const key of meta.keys) {
    const idx = key.map((k) => columns.indexOf(k));
    if (idx.some((i) => i < 0)) continue;
    if (row && idx.some((i) => row[i] === null)) continue;
    return key;
  }
  return null;
}

function where(key: string[], columns: ResultColumns, row: (string | null)[]): string {
  return key.map((k) => `${quoteIdent(k)} = ${sqlValue(row[columns.indexOf(k)])}`).join(" AND ");
}

export function deleteSql(t: TableRef, key: string[], columns: ResultColumns, row: (string | null)[]): string {
  return `DELETE FROM ${qualified(t)} WHERE ${where(key, columns, row)};`;
}

/** UPDATE setting one column (must map to a table column); selStart/selEnd cover the current value. */
export function updateSql(
  t: TableRef,
  key: string[],
  columns: ResultColumns,
  row: (string | null)[],
  col: number,
): { sql: string; selStart: number; selEnd: number } {
  const prefix = `UPDATE ${qualified(t)} SET ${quoteIdent(columns[col]!)} = `;
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

/** Comment text can't contain a line break, or the rest would become SQL. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

/** "integer, default" / "text, not null" / "text, nullable". */
function annotation(c: ColumnMeta): string {
  const kind = c.hasDefault || c.identity ? "default" : c.notNull ? "not null" : "nullable";
  return oneLine(`${c.displayType}, ${kind}`);
}

/** One "  <code>[,]  -- <comment>" line per item, comments aligned. */
function annotatedLines(items: { code: string; comment: string }[]): string {
  const codes = items.map((it, i) => it.code + (i < items.length - 1 ? "," : ""));
  const width = Math.max(...codes.map((c) => c.length));
  return codes.map((c, i) => `  ${c.padEnd(width)}  -- ${items[i].comment}`).join("\n");
}

/** INSERT with every non-generated column, one value per line, each annotated with column and type. */
export function insertSql(t: TableRef, meta: TableMeta): string {
  const cols = meta.columns.filter((c) => !c.generated);
  const lines = annotatedLines(cols.map((c) => ({ code: placeholder(c), comment: `${oneLine(c.name)}  ${annotation(c)}` })));
  return `INSERT INTO ${qualified(t)} (${cols.map((c) => quoteIdent(c.name)).join(", ")})\nVALUES (\n${lines}\n);`;
}

/**
 * UPDATE of the selected row, one SET line per editable column prefilled with its current value.
 * Editable: result columns read directly from the table, minus the key used in WHERE and columns
 * Postgres won't update (generated, identity). Null when nothing is editable.
 */
export function editRowSql(t: TableRef, meta: TableMeta, key: string[], columns: ResultColumns, row: (string | null)[]): string | null {
  const seen = new Set<string>(key);
  const items: { code: string; comment: string }[] = [];
  columns.forEach((name, i) => {
    const c = name === null ? undefined : meta.columns.find((m) => m.name === name);
    if (!c || seen.has(c.name) || c.generated || c.identity) return;
    seen.add(c.name);
    items.push({ code: `${quoteIdent(c.name)} = ${sqlValue(row[i])}`, comment: annotation(c) });
  });
  if (!items.length) return null;
  return `UPDATE ${qualified(t)} SET\n${annotatedLines(items)}\nWHERE ${where(key, columns, row)};`;
}
