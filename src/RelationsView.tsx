import { useState } from "react";
import { relatedQuery, relationBlocked, type Relation, type Relations } from "./rowSql.ts";

type Props = {
  rels: Relations;
  /** The tab's selected cell, read on click (selecting doesn't re-render this view). */
  getSelection: () => { values: (string | null)[]; col: number } | null;
  /** Open a new tab (on the owning tab's connection/database) titled `table` running `sql`. */
  onOpen: (table: string, sql: string) => void;
};

/** public tables by bare name; other schemas keep their prefix so same-named tables stay distinct. */
const nameOf = (r: { schema: string; table: string }) => (r.schema === "public" ? r.table : `${r.schema}.${r.table}`);
const details = (r: Relation) => `[${r.constraint}${r.onDelete ? `, on delete ${r.onDelete}` : ""}]`;

/**
 * Parents (→) and children (←) of the queried table. Arrows are greyed until a cell is selected:
 * CSS keys off data-has-sel on the tab's pane (set without re-rendering), so selecting a cell
 * re-renders nothing here. Clicking follows the FK from the selected row into a new tab.
 */
export function RelationsView({ rels, getSelection, onOpen }: Props) {
  const [note, setNote] = useState("");

  function follow(rel: Relation) {
    const s = getSelection();
    if (!s) return;
    const q = relatedQuery(rel, rels.resultColumns, s.values);
    if ("error" in q) return setNote(q.error);
    setNote("");
    onOpen(rel.table, q.sql);
  }

  const line = (rel: Relation, arrow: string, text: string) => {
    const blocked = relationBlocked(rel, rels.resultColumns);
    return (
      <div key={`${arrow}${rel.schema}.${rel.table}.${rel.constraint}`} className="rel-line">
        {"  "}
        <span
          className={blocked ? "rel-arrow" : "rel-arrow ok"}
          title={blocked ?? `Open ${nameOf(rel)} rows linked to the selected row (select a cell first)`}
          onClick={() => !blocked && follow(rel)}
        >
          {arrow}
        </span>
        {` ${text}   ${details(rel)}`}
      </div>
    );
  };

  return (
    <div className="bottom-body info-dump relations">
      <div>{`${rels.schema}.${rels.table}`}</div>
      <div>&nbsp;</div>
      <div>parents:</div>
      {rels.parents.length ? (
        rels.parents.map((r) => line(r, "→", `${r.cols.join(", ")} → ${nameOf(r)}[${r.otherCols.join(", ")}]`))
      ) : (
        <div>{"  (none)"}</div>
      )}
      <div>&nbsp;</div>
      <div>children:</div>
      {rels.children.length ? (
        rels.children.map((r) => line(r, "←", `${nameOf(r)}[${r.otherCols.join(", ")}] → ${r.cols.join(", ")}`))
      ) : (
        <div>{"  (none)"}</div>
      )}
      {note && <div className="rel-note">{note}</div>}
    </div>
  );
}
