/** What "Copy cell" puts on the clipboard: the value as displayed (NULL shows as NULL). */
export const cellText = (v: string | null) => v ?? "NULL";

export type DetailsInput = {
  columns: string[];
  row: (string | null)[];
  col: number;
  /** SQL and start time of the run whose results are on screen. */
  sql: string;
  ranAt: number;
  connection: string;
  database: string;
};

/** Result column names made unique for use as object keys: id, id (2), id (3)... */
function uniqueNames(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c} (${n})`;
  });
}

/** "Copy details": the selected field, its row, and where it came from, as pretty JSON. */
export function detailsJson(d: DetailsInput): string {
  const names = uniqueNames(d.columns);
  return JSON.stringify(
    {
      selectedFieldColumn: names[d.col],
      selectedFieldValue: d.row[d.col],
      selectedRow: Object.fromEntries(names.map((n, i) => [n, d.row[i]])),
      query: d.sql,
      queryTime: new Date(d.ranAt).toISOString(),
      dbConnection: d.connection,
      dbName: d.database,
    },
    null,
    2,
  );
}

/**
 * Whether a copy shortcut should act on the selected cell instead of the default copy:
 * not when text is selected, focus is in a text field, or a dialog is open.
 */
export function shouldCopyCell(doc: Document): boolean {
  const sel = doc.getSelection();
  if (sel && !sel.isCollapsed && sel.toString() !== "") return false;
  const el = doc.activeElement;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || (el as HTMLElement).isContentEditable)) return false;
  return !doc.querySelector("dialog[open]");
}
