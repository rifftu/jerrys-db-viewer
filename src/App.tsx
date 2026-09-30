import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tabLabels } from "./tabLabels";
import { ResultTable } from "./ResultTable";
import { CellDialog, type CellDialogHandle } from "./CellDialog";
import type { Connection, FkTarget, ResultSet, Selection } from "./types";
import { BottomPanel } from "./BottomPanel";
import { ReviewDialog, type Review, type ReviewDialogHandle } from "./ReviewDialog";
import { quoteIdent, quoteLiteral } from "./sql";

type Table = { schema: string; name: string };
type Tab = {
  id: number;
  title: string;
  /** Title is a table name (vs "New tab"). */
  fromTable: boolean;
  /** Start time (ms) of the most recent query. */
  lastRunAt: number | null;
  /** SQL of the most recent run (the bottom panel's Info describes its tables). */
  lastSql: string | null;
  /** Where this tab's queries run; independent of the sidebar and of other tabs. */
  target: Selection | null;
  sql: string;
  results: ResultSet[];
  error: string;
  busy: boolean;
  elapsed: number | null;
  /** Run that produced `results`. */
  resultsRun: number;
  /** FK target per result column, from the run it describes; arrives independently of results. */
  fks: { run: number; cols: (FkTarget | null)[] } | null;
};

/** Row limit for generated queries (opening a table, following an FK). */
const DEFAULT_LIMIT = 420;

let nextTabId = 1;
const makeTab = (target: Selection | null, table?: string, sql = ""): Tab => ({
  id: nextTabId++,
  title: table ?? "New tab",
  fromTable: table !== undefined,
  lastRunAt: null,
  lastSql: null,
  target,
  sql,
  results: [],
  error: "",
  busy: false,
  elapsed: null,
  resultsRun: 0,
  fks: null,
});

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  // Sidebar browsing state. Connection and database change together, so switching
  // connections resets to its configured dbname in one step without a fetch against the old db.
  const [sel, setSel] = useState<Selection | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [sidebarError, setSidebarError] = useState("");
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab(null)]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  // Latest run per tab; only that run may write results, so a slow earlier
  // query can't overwrite a newer one.
  const runIds = useRef(new Map<number, number>());
  const appRef = useRef<HTMLDivElement>(null);
  const cellDialog = useRef<CellDialogHandle>(null);
  const inspect = useCallback((value: string) => cellDialog.current?.open(value), []);
  const reviewDialog = useRef<ReviewDialogHandle>(null);
  const review = useCallback((r: Review) => reviewDialog.current?.open(r), []);

  const updateTab = useCallback((id: number, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  useEffect(() => {
    invoke<Connection[]>("list_connections")
      .then((list) => {
        setConnections(list);
        if (list.length) {
          const first = { conn: list[0].name, db: list[0].dbname };
          setSel(first);
          setTabs((ts) => ts.map((t) => (t.target ? t : { ...t, target: first })));
        }
      })
      .catch((e) => setSidebarError(String(e)));
  }, []);

  // The database list is server-wide, so it only depends on the connection.
  const defaultDb = connections.find((c) => c.name === sel?.conn)?.dbname;
  useEffect(() => {
    if (!sel || !defaultDb) return;
    let stale = false;
    setDatabases([]);
    invoke<string[]>("list_databases", { connection: sel.conn, database: defaultDb })
      .then((dbs) => !stale && setDatabases(dbs))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [sel?.conn, defaultDb]);

  useEffect(() => {
    if (!sel) return;
    let stale = false;
    setTables([]);
    setSidebarError("");
    invoke<Table[]>("list_tables", { connection: sel.conn, database: sel.db })
      .then((t) => !stale && setTables(t))
      .catch((e) => !stale && setSidebarError(String(e)));
    return () => {
      stale = true;
    };
  }, [sel?.conn, sel?.db]);

  const run = useCallback(
    async (tabId: number, on: Selection | null, query: string) => {
      if (!on || !query.trim()) return;
      const id = (runIds.current.get(tabId) ?? 0) + 1;
      runIds.current.set(tabId, id);
      updateTab(tabId, { busy: true, error: "", lastRunAt: Date.now(), lastSql: query });
      // Fired alongside the query (not awaited): the backend pipelines both on one
      // connection, and results render without waiting for FK info.
      invoke<(FkTarget | null)[] | null>("describe_columns", { connection: on.conn, database: on.db, sql: query })
        .then((cols) => runIds.current.get(tabId) === id && updateTab(tabId, { fks: cols ? { run: id, cols } : null }))
        .catch(() => {});
      const start = performance.now();
      let res: ResultSet[] = [];
      let err = "";
      try {
        res = await invoke<ResultSet[]>("run_query", { connection: on.conn, database: on.db, sql: query });
      } catch (e) {
        err = String(e);
      }
      if (runIds.current.get(tabId) !== id) return;
      updateTab(tabId, {
        results: res,
        resultsRun: id,
        error: err,
        elapsed: Math.round(performance.now() - start),
        busy: false,
      });
    },
    [updateTab],
  );

  const openFk = useCallback(
    (on: Selection, fk: FkTarget, value: string) => {
      const q = `SELECT * FROM ${quoteIdent(fk.schema)}.${quoteIdent(fk.table)} WHERE ${quoteIdent(fk.column)} = ${quoteLiteral(value)} LIMIT ${DEFAULT_LIMIT}`;
      const tab = makeTab(on, fk.table, q);
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
      run(tab.id, on, q);
    },
    [run],
  );

  // Labels depend only on these fields, so recompute when they change — not on every keystroke or result.
  const labelKey = tabs
    .map((t) => [t.id, t.title, t.fromTable, t.target?.conn, t.target?.db, t.lastRunAt].join("\u0000"))
    .join("\u0001");
  const labels = useMemo(
    () =>
      tabLabels(
        tabs.map((t) => ({
          id: t.id,
          title: t.title,
          fromTable: t.fromTable,
          conn: t.target?.conn ?? "",
          db: t.target?.db ?? "",
          lastRunAt: t.lastRunAt,
        })),
      ),
    [labelKey],
  );

  const setSql = useCallback((id: number, sql: string) => updateTab(id, { sql }), [updateTab]);

  function openTable(t: Table, inNewTab: boolean) {
    if (!sel) return;
    const q = `SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)} LIMIT ${DEFAULT_LIMIT}`;
    let tabId = activeId;
    if (inNewTab) {
      const tab = makeTab(sel, t.name, q);
      tabId = tab.id;
      setTabs((ts) => [...ts, tab]);
    } else {
      updateTab(tabId, { target: sel, title: t.name, fromTable: true, sql: q });
    }
    setActiveId(tabId);
    run(tabId, sel, q);
  }

  // Writes the sidebar width straight to a CSS variable on .app: no React state, so a
  // drag re-renders neither pane (the browser just re-lays out).
  function startPaneDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = appRef.current!;
    const startX = e.clientX;
    const startW = app.querySelector(".sidebar")!.getBoundingClientRect().width;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + ev.clientX - startX, 120), window.innerWidth - 200);
      app.style.setProperty("--sidebar-w", `${w}px`);
    };
    const up = () => {
      document.body.style.cursor = prevCursor;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function newTab() {
    const tab = makeTab(sel);
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }

  function closeTab(id: number) {
    runIds.current.delete(id);
    const i = tabs.findIndex((t) => t.id === id);
    let rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) rest = [makeTab(sel)];
    setTabs(rest);
    if (id === activeId) setActiveId(rest[Math.min(i, rest.length - 1)].id);
  }

  return (
    <div className="app" ref={appRef}>
      <aside className="sidebar">
        <select
          value={sel?.conn ?? ""}
          onChange={(e) => {
            const c = connections.find((c) => c.name === e.target.value);
            if (c) setSel({ conn: c.name, db: c.dbname });
          }}
        >
          {connections.length === 0 && <option value="">No connections</option>}
          {connections.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        {sel && (
          <select value={sel.db} onChange={(e) => setSel({ ...sel, db: e.target.value })}>
            {/* Keep the selected db listed even if listing databases failed. */}
            {(databases.includes(sel.db) ? databases : [sel.db, ...databases]).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        {sidebarError && <pre className="error">{sidebarError}</pre>}
        <ul className="tables">
          {tables.map((t) => (
            <li
              key={`${t.schema}.${t.name}`}
              title={`${t.schema}.${t.name} — double-click to open, ⌘-click to open in a new tab`}
              onDoubleClick={(e) => !(e.metaKey || e.ctrlKey) && openTable(t, false)}
              // detail === 1 so a ⌘-double-click doesn't open two tabs.
              onClick={(e) => (e.metaKey || e.ctrlKey) && e.detail === 1 && openTable(t, true)}
            >
              {t.schema === "public" ? t.name : `${t.schema}.${t.name}`}
            </li>
          ))}
        </ul>
      </aside>
      <div className="divider" onPointerDown={startPaneDrag} />
      <main className="main">
        <div className="tabbar">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={t.id === activeId ? "tab active" : "tab"}
              title={t.target ? `${t.target.conn} / ${t.target.db}` : undefined}
              onClick={() => setActiveId(t.id)}
            >
              <span className="tab-title">{labels.get(t.id)}</span>
              <button
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="tab-new" title="New tab" onClick={newTab}>
            +
          </button>
        </div>
        {/* Background tabs stay mounted (hidden) so switching is instant and keeps scroll position. */}
        {tabs.map((t) => (
          <TabPane key={t.id} tab={t} active={t.id === activeId} onSqlChange={setSql} onRun={run} onOpenFk={openFk} onInspect={inspect}
            connection={connections.find((c) => c.name === t.target?.conn)} onReview={review} />
        ))}
      </main>
      <CellDialog ref={cellDialog} />
      <ReviewDialog ref={reviewDialog} />
    </div>
  );
}

type TabPaneProps = {
  tab: Tab;
  active: boolean;
  onSqlChange: (id: number, sql: string) => void;
  onRun: (id: number, on: Selection | null, sql: string) => void;
  onOpenFk: (on: Selection, fk: FkTarget, value: string) => void;
  onInspect: (value: string) => void;
  connection: Connection | undefined;
  onReview: (review: Review) => void;
};

// Memoized so typing in or running one tab doesn't re-render other tabs' result tables.
const TabPane = memo(function TabPane({ tab, active, onSqlChange, onRun, onOpenFk, onInspect, connection, onReview }: TabPaneProps) {
  const { target, results, error, busy, elapsed } = tab;
  // Only trust FK info describing the run whose results are shown; describe works on single statements.
  const colFks = tab.fks && tab.fks.run === tab.resultsRun && results.length === 1 ? tab.fks.cols : null;
  const sqlRef = useRef<HTMLTextAreaElement>(null);
  // Option-click insert: only while this tab's SQL box has focus. Returns whether it inserted,
  // so the caller knows to cancel the mousedown (which keeps focus and the cursor here).
  const insertSql = useCallback(
    (text: string) => {
      const ta = sqlRef.current;
      if (!ta || document.activeElement !== ta) return false;
      // insertText keeps native undo and fires input -> onChange; fallback if unsupported.
      if (!document.execCommand("insertText", false, text)) {
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
        onSqlChange(tab.id, ta.value);
      }
      return true;
    },
    [tab.id, onSqlChange],
  );
  return (
    <div className="pane" hidden={!active}>
      <textarea
        ref={sqlRef}
        className="sql"
        rows={1}
        value={tab.sql}
        placeholder="SQL — Enter to run, Shift+Enter for newline"
        spellCheck={false}
        onChange={(e) => onSqlChange(tab.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onRun(tab.id, target, tab.sql);
          }
        }}
      />
      <div className="status">
        <span>{target ? `${target.conn} / ${target.db}` : ""}</span>
        <span>{busy ? "Running…" : elapsed !== null && !error ? `${elapsed} ms` : ""}</span>
      </div>
      <div className="results">
        {error && <pre className="error">{error}</pre>}
        {results.map((r, i) =>
          r.columns.length ? (
            // Keyed by run so a re-query starts with fresh (auto) column widths.
            <ResultTable key={`${tab.resultsRun}-${i}`} result={r} fks={colFks} target={target} onOpenFk={onOpenFk} onInspect={onInspect} onInsert={insertSql} />
          ) : (
            <div key={i} className="affected">
              {r.affected} row(s) affected
            </div>
          ),
        )}
      </div>
      <BottomPanel active={active} target={target} lastSql={tab.lastSql} connection={connection} onReview={onReview} />
    </div>
  );
});
