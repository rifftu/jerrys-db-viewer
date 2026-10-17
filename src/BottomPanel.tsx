import { memo, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Connection, ResultSet, Selection } from "./types";
import type { Review } from "./ReviewDialog";
import { RelationsView } from "./RelationsView";
import type { Relations } from "./rowSql.ts";
import { deleteSql, editRowSql, insertSql, pickKey, updateSql, type EditContext } from "./rowSql.ts";

type Props = {
  /** The owning tab is the visible one (Info only fetches then). */
  active: boolean;
  target: Selection | null;
  /** SQL of the tab's most recent run; Info describes the tables it touches. */
  lastSql: string | null;
  connection: Connection | undefined;
  onReview: (review: Review) => void;
  /** Open a new tab on this tab's connection/database (relations follow-through). */
  onOpenTab: (on: Selection, table: string, sql: string) => void;
  /** The last run's rows are on screen (single result set). Row shortcuts only look at the query then. */
  rowsShown: boolean;
  /** The tab's selected cell (read on click; selecting doesn't re-render this panel). */
  getSelection: () => { values: (string | null)[]; col: number } | null;
};

/** Height is shared across tabs: written straight to --bottom-h on .main, so dragging re-renders nothing. */
function startResize(e: ReactPointerEvent<HTMLDivElement>) {
  if (e.button !== 0) return;
  e.preventDefault();
  const main = e.currentTarget.closest(".main") as HTMLElement;
  const panel = e.currentTarget.parentElement!;
  const startY = e.clientY;
  const startH = panel.getBoundingClientRect().height;
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = "row-resize";
  const move = (ev: PointerEvent) => {
    const h = Math.min(Math.max(startH - (ev.clientY - startY), 60), main.clientHeight - 120);
    main.style.setProperty("--bottom-h", `${h}px`);
  };
  const up = () => {
    document.body.style.cursor = prevCursor;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * A backend command's answer about the tab's last query (Info, Relations). Fetched only while
 * visible; cached until the tab runs a different query. Null while loading.
 */
function useQueryResult<T>(
  command: string,
  visible: boolean,
  target: Selection | null,
  lastSql: string | null,
): { value: T } | { error: string } | null {
  const [res, setRes] = useState<{ key: string; value?: T; error?: string } | null>(null);
  const key = target && lastSql ? `${target.conn}\u0000${target.db}\u0000${lastSql}` : null;
  useEffect(() => {
    if (!visible || !key || !target || !lastSql || res?.key === key) return;
    let stale = false;
    invoke<T>(command, { connection: target.conn, database: target.db, sql: lastSql })
      .then((value) => !stale && setRes({ key, value }))
      .catch((e) => !stale && setRes({ key, error: String(e) }));
    return () => {
      stale = true;
    };
  }, [visible, key]);
  if (res?.key !== key) return null;
  return "error" in res && res.error !== undefined ? { error: res.error } : { value: res.value as T };
}

type PanelTab = "info" | "relations" | "edit";

function summarize(sets: ResultSet[]): string {
  return sets.map((s) => (s.columns.length ? `${s.rows.length} row(s) returned` : `${s.affected} row(s) affected`)).join("; ") || "done";
}

/** Per-tab bottom panel (a child of the tab's pane, so its state follows the tab). */
export const BottomPanel = memo(function BottomPanel({
  active,
  target,
  lastSql,
  connection,
  onReview,
  rowsShown,
  getSelection,
  onOpenTab,
}: Props) {
  const [panel, setPanel] = useState<PanelTab>("relations");
  const [collapsed, setCollapsed] = useState(false);
  const [editSql, setEditSql] = useState("");
  const [execResult, setExecResult] = useState<{ ok: boolean; text: string } | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [edit, setEdit] = useState<{ key: string; ctx: EditContext | null; error?: string } | null>(null);

  // Row shortcuts: the backend checks the last query reads exactly one table and maps result columns
  // onto it (describe + EXPLAIN, nothing executes). Only asked once its rows are on screen, only while
  // Edit is visible; cached until the tab runs a different query.
  const editKey = target && lastSql && rowsShown ? `${target.conn}\u0000${target.db}\u0000${lastSql}` : null;
  const editVisible = active && !collapsed && panel === "edit";
  useEffect(() => {
    if (!editVisible || !editKey || !target || !lastSql || edit?.key === editKey) return;
    let stale = false;
    invoke<EditContext>("edit_context", { connection: target.conn, database: target.db, sql: lastSql })
      .then((ctx) => !stale && setEdit({ key: editKey, ctx }))
      .catch((e) => !stale && setEdit({ key: editKey, ctx: null, error: String(e) }));
    return () => {
      stale = true;
    };
  }, [editVisible, editKey]);
  const ctx = edit?.key === editKey ? edit.ctx : null;
  const hasKey = !!(ctx && pickKey(ctx, ctx.resultColumns));
  const shortcutsOff = !editKey
    ? "Run a query on a single table first"
    : !ctx
      ? edit?.key === editKey
        ? (edit.error ?? "Not available for this query")
        : "Checking the query…"
      : null;
  const rowShortcutsOff =
    shortcutsOff ?? (hasKey ? null : `No primary key or plain unique index of ${ctx!.table} is in the result columns`);

  /** Replace the edit box with generated SQL (undoable), then focus it with an optional selection. */
  function fill(sql: string, sel?: [number, number]) {
    const ta = editRef.current;
    setExecResult(null);
    if (!ta) return setEditSql(sql);
    ta.focus();
    ta.select();
    if (document.execCommand("insertText", false, sql)) {
      // insertText updates the DOM synchronously, so the selection can be set right away.
      if (sel) ta.setSelectionRange(sel[0], sel[1]);
      return;
    }
    // Fallback: React applies the new value on the next render.
    setEditSql(sql);
    requestAnimationFrame(() => {
      ta.focus();
      if (sel) ta.setSelectionRange(sel[0], sel[1]);
    });
  }

  function rowShortcut(kind: "delete" | "edit" | "row") {
    if (!ctx) return;
    const s = getSelection();
    if (!s) return setExecResult({ ok: false, text: "Select a cell first." });
    const key = pickKey(ctx, ctx.resultColumns, s.values);
    if (!key) return setExecResult({ ok: false, text: "The selected row has NULL in every unique key; it can't be targeted." });
    if (kind === "delete") return fill(deleteSql(ctx, key, ctx.resultColumns, s.values));
    if (kind === "row") {
      const sql = editRowSql(ctx, ctx, key, ctx.resultColumns, s.values);
      if (!sql) return setExecResult({ ok: false, text: `No editable columns of ${ctx.table} in the result.` });
      return fill(sql);
    }
    if (ctx.resultColumns[s.col] === null) {
      return setExecResult({ ok: false, text: `That column isn't a column of ${ctx.table} (it's computed), so it can't be edited.` });
    }
    const u = updateSql(ctx, key, ctx.resultColumns, s.values, s.col);
    fill(u.sql, [u.selStart, u.selEnd]);
  }

  const shown = (p: PanelTab) => active && !collapsed && panel === p;
  const info = useQueryResult<string>("tables_info", shown("info"), target, lastSql);
  const relations = useQueryResult<Relations>("table_relations", shown("relations"), target, lastSql);

  function review() {
    if (!target || !editSql.trim()) return;
    const on = target;
    const sql = editSql;
    const where = connection ? `${connection.user}@${connection.host}:${connection.port}` : "?";
    onReview({
      command: `-- ${on.conn}: ${where} / ${on.db}\n${sql}`,
      execute: () => {
        setExecResult({ ok: true, text: "Running…" });
        invoke<ResultSet[]>("run_query", { connection: on.conn, database: on.db, sql })
          .then((sets) => setExecResult({ ok: true, text: summarize(sets) }))
          .catch((e) => setExecResult({ ok: false, text: String(e) }));
      },
    });
  }

  const pick = (p: PanelTab) => {
    // Clicking the open tab collapses/expands the panel.
    if (p === panel) setCollapsed((c) => !c);
    else {
      setPanel(p);
      setCollapsed(false);
    }
  };

  return (
    <div className={collapsed ? "bottom collapsed" : "bottom"}>
      {!collapsed && <div className="bottom-resize" onPointerDown={startResize} />}
      <div className="bottom-tabs">
        {(["relations", "info", "edit"] as const).map((p) => (
          <button key={p} className={p === panel ? "active" : undefined} onClick={() => pick(p)}>
            {p}
          </button>
        ))}
      </div>
      {!collapsed && panel === "info" && (
        <pre className="bottom-body info-dump">
          {!lastSql ? "Run a query to see its tables." : !info ? "Loading…" : "error" in info ? info.error : info.value}
        </pre>
      )}
      {!collapsed &&
        panel === "relations" &&
        (relations && "value" in relations && target ? (
          <RelationsView rels={relations.value} getSelection={getSelection} onOpen={(table, sql) => onOpenTab(target, table, sql)} />
        ) : (
          <pre className="bottom-body info-dump">
            {!lastSql ? "Run a query to see its tables." : !relations ? "Loading…" : "error" in relations ? relations.error : ""}
          </pre>
        ))}
      {!collapsed && panel === "edit" && (
        <div className="bottom-body edit">
          <div className="edit-header">
            <span className="edit-subtitle">don't do anything stupid!</span>
            <button disabled={!!rowShortcutsOff} title={rowShortcutsOff ?? "DELETE the selected row"} onClick={() => rowShortcut("delete")}>
              delete row
            </button>
            <button
              disabled={!!rowShortcutsOff}
              title={rowShortcutsOff ?? "UPDATE the selected cell"}
              onClick={() => rowShortcut("edit")}
            >
              edit value
            </button>
            <button
              disabled={!!rowShortcutsOff}
              title={rowShortcutsOff ?? "UPDATE every column of the selected row"}
              onClick={() => rowShortcut("row")}
            >
              edit row
            </button>
            <button
              disabled={!!shortcutsOff}
              title={shortcutsOff ?? "INSERT a new row"}
              onClick={() => ctx && fill(insertSql(ctx, ctx))}
            >
              add row
            </button>
          </div>
          <div className="edit-box">
            <textarea ref={editRef} value={editSql} spellCheck={false} onChange={(e) => setEditSql(e.target.value)} />
            <button className="edit-review" onClick={review} disabled={!target || !editSql.trim()}>
              review
            </button>
          </div>
          {execResult && <div className={execResult.ok ? "edit-result" : "edit-result error"}>{execResult.text}</div>}
        </div>
      )}
    </div>
  );
});
