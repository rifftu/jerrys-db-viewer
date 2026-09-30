/** `"name"` with embedded double quotes doubled. */
export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** `'value'` with embedded single quotes doubled. */
export const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A cell value as SQL: a literal, or bare NULL. */
export const sqlValue = (v: string | null) => (v === null ? "NULL" : quoteLiteral(v));
