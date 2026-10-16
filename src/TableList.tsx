import { Fragment, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Table } from "./types";

type Props = {
  tables: Table[];
  onOpen: (t: Table, inNewTab: boolean) => void;
};

/**
 * Sidebar table list: public tables flat, every other schema collapsed into a folder.
 * Folder open/closed state is local, so toggling re-renders only this list. Remount it (key)
 * on connection/database change to start collapsed.
 */
export function TableList({ tables, onOpen }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (schema: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(schema)) next.add(schema);
      return next;
    });

  // Tables arrive sorted public-first, then by schema and name, so one pass groups them.
  const flat: Table[] = [];
  const folders = new Map<string, Table[]>();
  for (const t of tables) {
    if (t.schema === "public") flat.push(t);
    else if (folders.has(t.schema)) folders.get(t.schema)!.push(t);
    else folders.set(t.schema, [t]);
  }

  const row = (t: Table, label: string, nested: boolean) => (
    <li
      key={`${t.schema}.${t.name}`}
      className={nested ? "nested" : undefined}
      title={`${t.schema}.${t.name} — double-click to open, ⌘-click to open in a new tab`}
      onDoubleClick={(e: ReactMouseEvent) => !(e.metaKey || e.ctrlKey) && onOpen(t, false)}
      // detail === 1 so a ⌘-double-click doesn't open two tabs.
      onClick={(e: ReactMouseEvent) => (e.metaKey || e.ctrlKey) && e.detail === 1 && onOpen(t, true)}
    >
      {label}
    </li>
  );

  return (
    <ul className="tables">
      {flat.map((t) => row(t, t.name, false))}
      {[...folders].map(([schema, ts]) => {
        const isOpen = open.has(schema);
        return (
          <Fragment key={`schema:${schema}`}>
            <li className="folder" title={`${ts.length} table(s) in ${schema}`} onClick={() => toggle(schema)}>
              <span className="caret">{isOpen ? "▾" : "▸"}</span>
              {schema}
            </li>
            {isOpen && ts.map((t) => row(t, t.name, true))}
          </Fragment>
        );
      })}
    </ul>
  );
}
