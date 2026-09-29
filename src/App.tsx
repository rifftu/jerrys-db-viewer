import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tabLabels } from "./tabLabels";

type Connection = { name: string; dbname: string };
type Selection = { conn: string; db: string };
type Table = { schema: string; name: string };
type ResultSet = { columns: string[]; rows: (string | null)[][]; affected: number };
type Tab = {
  id: number;
  title: string;
  /** Title is a table name (vs "New tab"). */
  fromTable: boolean;
  /** Start time (ms) of the most recent query. */
  lastRunAt: number | null;
  /** Where this tab's queries run; independent of the sidebar and of other tabs. */
  target: Selection | null;
  sql: string;
  results: ResultSet[];
  error: string;
  busy: boolean;
  elapsed: number | null;
};

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

let nextTabId = 1;
const makeTab = (target: Selection | null, table?: string, sql = ""): Tab => ({
  id: nextTabId++,
  title: table ?? "New tab",
  fromTable: table !== undefined,
  lastRunAt: null,
  target,
  sql,
  results: [],
  error: "",
  busy: false,
  elapsed: null,
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
      updateTab(tabId, { busy: true, error: "", lastRunAt: Date.now() });
      const start = performance.now();
      let res: ResultSet[] = [];
      let err = "";
      try {
        res = await invoke<ResultSet[]>("run_query", { connection: on.conn, database: on.db, sql: query });
      } catch (e) {
        err = String(e);
      }
      if (runIds.current.get(tabId) !== id) return;
      updateTab(tabId, { results: res, error: err, elapsed: Math.round(performance.now() - start), busy: false });
    },
    [updateTab],
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
    const q = `SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)} LIMIT 1000`;
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
    <div className="app">
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
          <TabPane key={t.id} tab={t} active={t.id === activeId} onSqlChange={setSql} onRun={run} />
        ))}
      </main>
    </div>
  );
}

type TabPaneProps = {
  tab: Tab;
  active: boolean;
  onSqlChange: (id: number, sql: string) => void;
  onRun: (id: number, on: Selection | null, sql: string) => void;
};

// Memoized so typing in or running one tab doesn't re-render other tabs' result tables.
const TabPane = memo(function TabPane({ tab, active, onSqlChange, onRun }: TabPaneProps) {
  const { target, results, error, busy, elapsed } = tab;
  return (
    <div className="pane" hidden={!active}>
      <textarea
        className="sql"
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
            <table key={i}>
              <thead>
                <tr>
                  {r.columns.map((c, j) => (
                    <th key={j}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((v, k) => (
                      <td key={k} className={v === null ? "null" : undefined}>
                        {v ?? "NULL"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div key={i} className="affected">
              {r.affected} row(s) affected
            </div>
          ),
        )}
      </div>
    </div>
  );
});
