import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "./primitives";
import { IconClose } from "./Icons";
import { useI18n } from "../i18n";

export interface DialogButton {
  label: string;
  /** Returned from the dialog promise when this button is pressed. */
  value: string;
  variant?: ButtonVariant;
}

export interface DialogRequest {
  title: string;
  body?: ReactNode;
  /** Machine-facing text behind a disclosure; monospace, copyable. */
  detail?: string;
  tone?: "neutral" | "success" | "warning" | "error";
  /** Defaults to a single confirming button. */
  buttons?: DialogButton[];
  /** Returned when dismissed with Escape, the scrim or the close button. */
  dismissValue?: string;
  /** Hides the close affordance; the dialog must be answered. */
  mandatory?: boolean;
  icon?: ReactNode;
}

/**
 * Modal M3 dialog.
 *
 * Deliberately not a `<dialog>` element: WebKitGTK's native modal traps focus
 * inside the shadow-less top layer and the app's custom titlebar stops
 * receiving drag events while it is open. Focus handling is done here instead,
 * which is a few lines and behaves identically on every host.
 */
export function Dialog({ request, onResolve }: { request: DialogRequest; onResolve: (value: string) => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);

  const buttons = request.buttons ?? [{ label: t("dialog.ok"), value: "ok", variant: "filled" as ButtonVariant }];
  const dismiss = request.dismissValue ?? buttons[buttons.length - 1]?.value ?? "ok";
  const dismissible = !request.mandatory;

  const close = useCallback(() => {
    if (dismissible) onResolve(dismiss);
  }, [dismissible, dismiss, onResolve]);

  // Focus the card so Escape and Tab land inside it rather than on whatever
  // the user last clicked in the shell behind the scrim.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const previous = document.activeElement as HTMLElement | null;
    const target = card.querySelector<HTMLElement>("[data-autofocus], button, [href], input, select, textarea");
    (target ?? card).focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      // Cycle focus within the card: a modal that lets Tab reach the sliders
      // behind it lets the user change settings they cannot see.
      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const copyDetail = async () => {
    if (!request.detail) return;
    try {
      await navigator.clipboard.writeText(request.detail);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be denied outright; the text is on screen and
      // selectable, so there is nothing further worth interrupting for.
    }
  };

  return (
    <div className="m3-dialog-scrim" onPointerDown={close}>
      <div
        ref={cardRef}
        tabIndex={-1}
        className={`m3-dialog m3-dialog--${request.tone ?? "neutral"}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {request.icon && (
          <span className="m3-dialog__icon" aria-hidden="true">
            {request.icon}
          </span>
        )}

        <div className="m3-dialog__head">
          <h2 id={titleId} className="m3-dialog__title">
            {request.title}
          </h2>
          {dismissible && (
            <button className="m3-dialog__close" onClick={close} aria-label={t("dialog.close")} type="button">
              <IconClose />
            </button>
          )}
        </div>

        {request.body && <div className="m3-dialog__body">{request.body}</div>}

        {request.detail && (
          <div className="m3-dialog__detail">
            <button
              type="button"
              className="m3-dialog__disclosure"
              aria-expanded={showDetail}
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? t("dialog.hideDetails") : t("dialog.showDetails")}
            </button>
            {showDetail && (
              <>
                <pre className="m3-dialog__pre">{request.detail}</pre>
                <button type="button" className="m3-dialog__disclosure" onClick={() => void copyDetail()}>
                  {copied ? t("dialog.copied") : t("dialog.copyDetails")}
                </button>
              </>
            )}
          </div>
        )}

        <footer className="m3-dialog__foot">
          {buttons.map((button, i) => (
            <Button
              key={button.value}
              variant={button.variant ?? (i === buttons.length - 1 ? "filled" : "text")}
              data-autofocus={i === buttons.length - 1 ? "" : undefined}
              onClick={() => onResolve(button.value)}
            >
              {button.label}
            </Button>
          ))}
        </footer>
      </div>
    </div>
  );
}
