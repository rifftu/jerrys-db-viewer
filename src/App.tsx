import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Connection = { name: string; dbname: string };
type Selection = { conn: string; db: string };
type Table = { schema: string; name: string };
type ResultSet = { columns: string[]; rows: (string | null)[][]; affected: number };

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  // Connection and database change together, so switching connections resets
  // to its configured dbname in one step without a fetch against the old db.
  const [sel, setSel] = useState<Selection | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [sql, setSql] = useState("");
  const [results, setResults] = useState<ResultSet[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    invoke<Connection[]>("list_connections")
      .then((list) => {
        setConnections(list);
        if (list.length) setSel({ conn: list[0].name, db: list[0].dbname });
      })
      .catch((e) => setError(String(e)));
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
    setResults([]);
    setElapsed(null);
    setError("");
    invoke<Table[]>("list_tables", { connection: sel.conn, database: sel.db })
      .then((t) => !stale && setTables(t))
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [sel?.conn, sel?.db]);

  async function run(query: string) {
    if (!sel || !query.trim()) return;
    setBusy(true);
    setError("");
    const start = performance.now();
    try {
      setResults(await invoke<ResultSet[]>("run_query", { connection: sel.conn, database: sel.db, sql: query }));
    } catch (e) {
      setResults([]);
      setError(String(e));
    } finally {
      setElapsed(Math.round(performance.now() - start));
      setBusy(false);
    }
  }

  function openTable(t: Table) {
    const q = `SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)} LIMIT 1000`;
    setSql(q);
    run(q);
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
        <ul className="tables">
          {tables.map((t) => (
            <li key={`${t.schema}.${t.name}`} onClick={() => openTable(t)} title={`${t.schema}.${t.name}`}>
              {t.schema === "public" ? t.name : `${t.schema}.${t.name}`}
            </li>
          ))}
        </ul>
      </aside>
      <main className="main">
        <textarea
          className="sql"
          value={sql}
          placeholder="SQL — Enter to run, Shift+Enter for newline"
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              run(sql);
            }
          }}
        />
        <div className="status">
          {busy ? "Running…" : elapsed !== null && !error ? `${elapsed} ms` : ""}
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
      </main>
    </div>
  );
}
