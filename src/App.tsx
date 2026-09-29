import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Table = { schema: string; name: string };
type ResultSet = { columns: string[]; rows: (string | null)[][]; affected: number };

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export default function App() {
  const [connections, setConnections] = useState<string[]>([]);
  const [conn, setConn] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [sql, setSql] = useState("");
  const [results, setResults] = useState<ResultSet[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    invoke<string[]>("list_connections")
      .then((names) => {
        setConnections(names);
        if (names.length) setConn(names[0]);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!conn) return;
    setTables([]);
    setResults([]);
    setError("");
    invoke<Table[]>("list_tables", { connection: conn })
      .then(setTables)
      .catch((e) => setError(String(e)));
  }, [conn]);

  async function run(query: string) {
    if (!conn || !query.trim()) return;
    setBusy(true);
    setError("");
    const start = performance.now();
    try {
      setResults(await invoke<ResultSet[]>("run_query", { connection: conn, sql: query }));
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
        <select value={conn} onChange={(e) => setConn(e.target.value)}>
          {connections.length === 0 && <option value="">No connections</option>}
          {connections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
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
