import { forwardRef, useImperativeHandle, useRef, useState } from "react";

export type Review = { command: string; execute: () => void };
export type ReviewDialogHandle = { open: (review: Review) => void };

/**
 * Shows exactly what will run and where; "execute" runs what was reviewed (captured at open).
 * No close button: backdrop click or Esc closes it.
 */
export const ReviewDialog = forwardRef<ReviewDialogHandle>(function ReviewDialog(_, ref) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<Review | null>(null);

  useImperativeHandle(ref, () => ({
    open(r) {
      setReview(r);
      dialogRef.current?.showModal();
    },
  }));

  return (
    <dialog
      ref={dialogRef}
      className="cell-dialog review-dialog"
      onClick={(e) => e.target === e.currentTarget && dialogRef.current?.close()}
    >
      <pre className="cell-dialog-body">{review?.command}</pre>
      <div className="cell-dialog-footer">
        <button
          onClick={() => {
            dialogRef.current?.close();
            review?.execute();
          }}
        >
          execute
        </button>
      </div>
    </dialog>
  );
});
