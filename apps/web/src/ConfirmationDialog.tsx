import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** A centered, reusable confirmation surface for destructive or consequential actions. */
export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [origin, setOrigin] = useState({ x: "50%", y: "50%" });
  const [visible, setVisible] = useState(open);
  const [phase, setPhase] = useState<"opening" | "open" | "closing" | "closed">(
    open ? "open" : "closed",
  );

  useEffect(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    if (open) {
      setVisible(true);
      setPhase("opening");
      const frame = window.requestAnimationFrame(() => setPhase("open"));
      return () => window.cancelAnimationFrame(frame);
    }
    if (!visible) return;
    setPhase("closing");
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setVisible(false);
      setPhase("closed");
    }, 180);
    return undefined;
  }, [open, visible]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;
      }
    },
    [],
  );

  const measureOrigin = useCallback(() => {
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    if (dialog === null || trigger?.isConnected !== true) return;
    const dialogBounds = dialog.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    setOrigin({
      x: `${triggerBounds.left + triggerBounds.width / 2 - dialogBounds.left}px`,
      y: `${triggerBounds.top + triggerBounds.height / 2 - dialogBounds.top}px`,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open || !visible) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !dialogRef.current?.contains(active)
    ) {
      triggerRef.current = active;
    } else {
      triggerRef.current = undefined;
      setOrigin({ x: "50%", y: "50%" });
    }
    measureOrigin();
  }, [measureOrigin, open, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    const handleLayout = () => measureOrigin();
    window.addEventListener("resize", handleLayout);
    window.visualViewport?.addEventListener("resize", handleLayout);
    document.addEventListener("fullscreenchange", handleLayout);
    return () => {
      window.removeEventListener("resize", handleLayout);
      window.visualViewport?.removeEventListener("resize", handleLayout);
      document.removeEventListener("fullscreenchange", handleLayout);
    };
  }, [measureOrigin, open, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [busy, onCancel, open, visible]);

  if (!visible) return null;

  return (
    <div
      className="confirmation-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <dialog
        ref={dialogRef}
        className="confirmation-dialog"
        data-confirmation-phase={phase}
        open
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        style={
          {
            "--confirmation-origin-x": origin.x,
            "--confirmation-origin-y": origin.y,
          } as CSSProperties
        }
      >
        <div className="confirmation-dialog__icon" aria-hidden="true">
          !
        </div>
        <div className="confirmation-dialog__body">
          <p className="confirmation-dialog__eyebrow">Confirm action</p>
          <h2 id={titleId}>{title}</h2>
          <div id={descriptionId} className="confirmation-dialog__description">
            {description}
          </div>
        </div>
        <div className="confirmation-dialog__actions">
          <button ref={cancelButtonRef} type="button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="confirmation-dialog__confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </dialog>
    </div>
  );
}
