import { forwardRef, useImperativeHandle, useRef, useState } from "react";

export type CellDialogHandle = { open: (value: string) => void };

/**
 * Shows one field's full value. Owns its own state and is opened through a ref,
 * so opening it doesn't re-render the rest of the app.
 */
export const CellDialog = forwardRef<CellDialogHandle>(function CellDialog(_, ref) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");

  useImperativeHandle(ref, () => ({
    open(v) {
      setValue(v);
      dialogRef.current?.showModal();
    },
  }));

  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      className="cell-dialog"
      // Clicks on the backdrop land on the <dialog> itself.
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <pre className="cell-dialog-body">{value}</pre>
      <div className="cell-dialog-footer">
        <button onClick={() => navigator.clipboard.writeText(value).catch(() => {})}>copy</button>
        <button onClick={close}>close</button>
      </div>
    </dialog>
  );
});
