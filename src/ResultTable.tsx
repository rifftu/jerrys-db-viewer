import { useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { FkTarget, ResultSet, Selection } from "./types";

type Props = {
  result: ResultSet;
  fks: (FkTarget | null)[] | null;
  target: Selection | null;
  onOpenFk: (on: Selection, fk: FkTarget, value: string) => void;
  /** Long-press on a cell: show its value (as displayed). */
  onInspect: (value: string) => void;
};

/** A data cell resolved from a DOM event target. */
type Cell = { row: number; col: number; value: string | null; fk: FkTarget | null };

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 4;

const MIN_WIDTH = 16;

/** Pixel width of `n` characters in the element's font, plus the cell's horizontal padding and border. */
function charsWidth(el: HTMLElement, n: number): number {
  const style = getComputedStyle(el);
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = style.font;
  const extra =
    parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  return Math.ceil(ctx.measureText("0".repeat(n)).width + extra);
}

/**
 * Column widths are auto until the first resize, which snapshots every column's rendered
 * width as its default and switches the table to fixed layout. Widths are local state, so a
 * re-query (which remounts this component) starts from auto again.
 */
export function ResultTable({ result, fks, target, onOpenFk, onInspect }: Props) {
  const tableRef = useRef<HTMLTableElement>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);

  /**
   * Resolves an event target to the data cell under it. All cell interactions go through
   * delegated listeners on <table> plus this lookup, so rows carry no per-cell handlers.
   * Assumes rendered rows/cells map 1:1 onto `result.rows` (no virtualization, reordering
   * or hidden columns; one <tbody>).
   */
  function cellAt(target: EventTarget): Cell | null {
    const td = (target as HTMLElement).closest?.("tbody td") as HTMLTableCellElement | null;
    if (!td || !tableRef.current?.contains(td)) return null;
    const row = (td.parentElement as HTMLTableRowElement).sectionRowIndex;
    const col = td.cellIndex;
    const value = result.rows[row]?.[col];
    if (value === undefined) return null;
    return { row, col, value, fk: fks?.[col] ?? null };
  }

  function onClick(e: ReactMouseEvent<HTMLTableElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const cell = cellAt(e.target);
    if (cell?.fk && cell.value !== null && target) onOpenFk(target, cell.fk, cell.value);
  }

  // Long press: show the value as displayed.
  function cancelPress() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }

  function startPress(e: ReactPointerEvent<HTMLTableElement>) {
    cancelPress();
    if (e.button !== 0) return;
    const cell = cellAt(e.target);
    if (!cell) return;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        onInspect(cell.value ?? "NULL");
      }, LONG_PRESS_MS),
    };
  }

  function movePress(e: ReactPointerEvent<HTMLTableElement>) {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancelPress();
  }

  const defaults = useRef<number[] | null>(null);
  // Mirrored in a ref so drag handlers (closures from the pointerdown render) see the latest widths.
  const widthsRef = useRef<number[] | null>(null);
  const [widths, setWidths] = useState<number[] | null>(null);

  /** Snapshot auto widths as the defaults on first use; returns the current widths. */
  function frozen(): number[] {
    if (!widthsRef.current) {
      const ths = tableRef.current!.querySelectorAll("thead th");
      defaults.current = Array.from(ths, (th) => th.getBoundingClientRect().width);
      widthsRef.current = defaults.current;
    }
    return widthsRef.current;
  }

  function setWidth(i: number, w: number) {
    const next = [...frozen()];
    next[i] = Math.max(MIN_WIDTH, w);
    widthsRef.current = next;
    setWidths(next);
  }

  function startDrag(i: number, e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = frozen()[i];
    const move = (ev: PointerEvent) => setWidth(i, startW + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Rows don't depend on widths, so resizing only re-renders the header and colgroup.
  const body = useMemo(
    () => (
      <tbody>
        {result.rows.map((row, j) => (
          <tr key={j}>
            {row.map((v, k) => {
              const fk = fks?.[k];
              if (v === null) {
                return (
                  <td key={k} className="null">
                    NULL
                  </td>
                );
              }
              if (fk && target) {
                return (
                  <td key={k} className="fk" title={`⌘-click: ${fk.table}.${fk.column} = ${v}`}>
                    {v}
                  </td>
                );
              }
              return <td key={k}>{v}</td>;
            })}
          </tr>
        ))}
      </tbody>
    ),
    [result, fks, target],
  );

  return (
    <table
      ref={tableRef}
      onClick={onClick}
      onPointerDown={startPress}
      onPointerMove={movePress}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      className={widths ? "sized" : undefined}
      style={widths ? { width: widths.reduce((a, b) => a + b, 0) } : undefined}
    >
      {widths && (
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
      )}
      <thead>
        <tr>
          {result.columns.map((c, i) => (
            <th key={i} title={c} onDoubleClick={(e) => setWidth(i, charsWidth(e.currentTarget, 3))}>
              {c}
              <div
                className="col-resize"
                title="Drag to resize, double-click to reset"
                onPointerDown={(e) => startDrag(i, e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  frozen();
                  setWidth(i, defaults.current![i]);
                }}
              />
            </th>
          ))}
        </tr>
      </thead>
      {body}
    </table>
  );
}
