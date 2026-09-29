import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { FkTarget, ResultSet, Selection } from "./types";

type Props = {
  result: ResultSet;
  fks: (FkTarget | null)[] | null;
  target: Selection | null;
  onOpenFk: (on: Selection, fk: FkTarget, value: string) => void;
};

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
export function ResultTable({ result, fks, target, onOpenFk }: Props) {
  const tableRef = useRef<HTMLTableElement>(null);
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
                  <td
                    key={k}
                    className="fk"
                    title={`⌘-click: ${fk.table}.${fk.column} = ${v}`}
                    onClick={(e) => (e.metaKey || e.ctrlKey) && onOpenFk(target, fk, v)}
                  >
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
    [result, fks, target, onOpenFk],
  );

  return (
    <table
      ref={tableRef}
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
