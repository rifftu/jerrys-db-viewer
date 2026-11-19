/** `"name"` with embedded double quotes doubled. */
export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** `'value'` with embedded single quotes doubled. */
export const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A cell value as SQL: a literal, or bare NULL. */
export const sqlValue = (v: string | null) => (v === null ? "NULL" : quoteLiteral(v));

const IDENT = `(?:"(?:[^"]|"")+"|[\\w$]+)`;
const TABLE_REF = new RegExp(`\\b(from|join|into|update)\\s+(?:only\\s+)?(${IDENT}(?:\\s*\\.\\s*${IDENT})*)(?![\\w$"])\\s*(\\(?)`, "gi");

/**
 * Tab title for a query, with no round trip: the first table it names (after FROM / JOIN / INTO /
 * UPDATE, skipping subqueries and function calls), else the start of the SQL. A text scan, not
 * a parser, so unusual SQL can pick an odd name.
 */
export function titleFromSql(sql: string): { title: string; fromTable: boolean } {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const m of bare.matchAll(TABLE_REF)) {
    // FROM/JOIN name(...) is a function call (generate_series); INTO name (...) is a column list.
    if (m[3] && /^(from|join)$/i.test(m[1])) continue;
    const last = m[2].match(new RegExp(IDENT, "g"))!.at(-1)!;
    return { title: last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last, fromTable: true };
  }
  return { title: sql.trim().replace(/\s+/g, " ").slice(0, 24), fromTable: false };
}

/** Row limit for generated queries (opening a table, following an FK or relation). */
export const DEFAULT_LIMIT = 420;
