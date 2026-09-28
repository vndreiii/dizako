import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog, type DialogRequest } from "./Dialog";
import { IconClose, IconCheck, IconTune } from "./Icons";
import { useI18n } from "../i18n";
import {
  diagnostics,
  isAppError,
  shortDetail,
  toAppError,
  type AppError,
  type Recovery,
} from "../errors";

export type Tone = "neutral" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  tone?: Tone;
  /** Milliseconds on screen; 0 keeps it until dismissed. */
  duration?: number;
  action?: ToastAction;
  /** Machine-facing text; surfaces a Details button that opens a dialog. */
  detail?: string;
  /**
   * Collapses repeats. A second toast with the same key replaces the first
   * instead of stacking - the difference between one "frame 118 failed" line
   * and three hundred of them.
   */
  key?: string;
}

interface Toast extends ToastOptions {
  id: number;
  text: string;
  /** Repeat count, rendered as a ×N badge once above one. */
  count: number;
}

/** Long-lived prompt with its own actions, e.g. the update offer. */
export interface SnackbarPrompt {
  text: string;
  actions: Array<{ label: string; onClick: () => void }>;
}

export interface NotifyApi {
  /** Transient message. Returns the id so a caller can dismiss it early. */
  toast(text: string, options?: ToastOptions): number;
  dismiss(id: number): void;
  /** Modal question. Resolves with the pressed button's `value`. */
  dialog(request: DialogRequest): Promise<string>;
  /**
   * The single funnel for failures. Localises the code, picks toast or
   * dialog by severity, and wires the recovery button.
   */
  fail(error: unknown, options?: FailOptions): void;
  prompt(prompt: SnackbarPrompt | null): void;
}

export interface FailOptions {
  /** Overrides the severity-derived presentation. */
  as?: "toast" | "dialog";
  /** Invoked when the user takes the offered recovery action. */
  onRecover?: () => void;
  /** Extra key/value pairs folded into copied diagnostics. */
  context?: Record<string, unknown>;
}

const DEFAULT_DURATION = 4200;
const ERROR_DURATION = 9000;
/** Above this the oldest toast is dropped; a wall of them informs nobody. */
const MAX_VISIBLE = 3;

const NotifyContext = createContext<NotifyApi | null>(null);

export function useNotify(): NotifyApi {
  const api = useContext(NotifyContext);
  if (!api) throw new Error("useNotify used outside NotifyProvider");
  return api;
}

/** Back-compatible shim for the original `snack(text, tone)` call shape. */
export function useSnackbar() {
  const { toast } = useNotify();
  return useCallback(
    (text: string, tone: "neutral" | "error" = "neutral") => {
      toast(text, { tone });
    },
    [toast],
  );
}

export function useSnackbarPrompt() {
  return useNotify().prompt;
}

interface PendingDialog {
  id: number;
  request: DialogRequest;
  resolve: (value: string) => void;
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [prompt, setPrompt] = useState<SnackbarPrompt | null>(null);
  const [dialogs, setDialogs] = useState<PendingDialog[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((q) => q.filter((m) => m.id !== id));
  }, []);

  const arm = useCallback(
    (id: number, duration: number) => {
      if (duration <= 0) return;
      const existing = timers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          setToasts((q) => q.filter((m) => m.id !== id));
        }, duration),
      );
    },
    [],
  );

  const toast = useCallback(
    (text: string, options: ToastOptions = {}): number => {
      const tone = options.tone ?? "neutral";
      const duration = options.duration ?? (tone === "error" ? ERROR_DURATION : DEFAULT_DURATION);
      let id = -1;
      setToasts((q) => {
        // A keyed repeat refreshes the existing line and bumps its counter, so
        // a failure that recurs per frame stays one row.
        if (options.key) {
          const found = q.find((m) => m.key === options.key);
          if (found) {
            id = found.id;
            return q.map((m) =>
              m.id === found.id ? { ...m, ...options, text, tone, count: m.count + 1 } : m,
            );
          }
        }
        id = seq.current++;
        const next = [...q, { ...options, id, text, tone, count: 1 }];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      // Arming after the state update keeps the timer keyed to the real id,
      // including the refreshed-repeat case.
      queueMicrotask(() => arm(id, duration));
      return id;
    },
    [arm],
  );

  const dialog = useCallback((request: DialogRequest): Promise<string> => {
    const id = seq.current++;
    return new Promise<string>((resolve) => {
      setDialogs((q) => [...q, { id, request, resolve }]);
    });
  }, []);

  const resolveDialog = useCallback((id: number, value: string) => {
    setDialogs((q) => {
      const found = q.find((d) => d.id === id);
      found?.resolve(value);
      return q.filter((d) => d.id !== id);
    });
  }, []);

  /** Localised copy for one error code, with `{placeholder}` substitution. */
  const copyFor = useCallback(
    (error: AppError) => {
      const fill = (text: string) => {
        if (!error.values) return text;
        let out = text;
        for (const [key, value] of Object.entries(error.values)) {
          out = out.split(`{${key}}`).join(String(value));
        }
        return out;
      };
      const titleKey = `error.${error.code}.title`;
      const bodyKey = `error.${error.code}.body`;
      const title = t(titleKey);
      const body = t(bodyKey);
      return {
        // A missing key comes back as the key itself; fall back to something
        // readable rather than printing dot-notation at the user.
        title: title === titleKey ? t("error.app/unknown.title") : fill(title),
        body: body === bodyKey ? "" : fill(body),
      };
    },
    [t],
  );

  const recoveryLabel = useCallback(
    (recovery: Recovery): string | null => (recovery === "none" ? null : t(`recovery.${recovery}`)),
    [t],
  );

  const fail = useCallback(
    (thrown: unknown, options: FailOptions = {}) => {
      const error = toAppError(thrown);
      const { title, body } = copyFor(error);
      const detail = [error.detail, diagnostics({ code: error.code, ...(options.context ?? {}) })]
        .filter(Boolean)
        .join("\n\n--- diagnostics ---\n");

      // Logged unconditionally: the console trail is what makes a report
      // reproducible even when the user only remembers "it showed a dialog".
      if (error.severity === "error") console.error(`[dizako] ${error.code}`, error.cause ?? error.detail ?? "");
      else console.warn(`[dizako] ${error.code}`, error.cause ?? error.detail ?? "");

      const label = recoveryLabel(error.recovery);
      const runRecovery = () => {
        switch (error.recovery) {
          case "reload":
            window.location.reload();
            return;
          case "report":
            void navigator.clipboard?.writeText(detail).then(
              () => toast(t("dialog.copied"), { tone: "success" }),
              () => {},
            );
            return;
          default:
            options.onRecover?.();
        }
      };
      // A recovery with no handler and no built-in behaviour is not a button
      // worth showing - it would do nothing when pressed.
      const actionable =
        label !== null &&
        (error.recovery === "reload" || error.recovery === "report" || Boolean(options.onRecover));

      const present = options.as ?? (error.severity === "error" ? "dialog" : "toast");

      if (present === "toast") {
        toast(body ? `${title} — ${body}` : title, {
          tone: error.severity === "warning" ? "warning" : "error",
          detail,
          key: error.code,
          action: actionable ? { label: label!, onClick: runRecovery } : undefined,
        });
        return;
      }

      void dialog({
        title,
        body: body || undefined,
        detail,
        tone: error.severity === "warning" ? "warning" : "error",
        buttons: actionable
          ? [
              { label: t("dialog.dismiss"), value: "dismiss", variant: "text" },
              { label: label!, value: "recover", variant: "filled" },
            ]
          : [{ label: t("dialog.ok"), value: "ok", variant: "filled" }],
        dismissValue: "dismiss",
      }).then((choice) => {
        if (choice === "recover") runRecovery();
      });
    },
    [copyFor, dialog, recoveryLabel, t, toast],
  );

  const api = useMemo<NotifyApi>(
    () => ({ toast, dismiss, dialog, fail, prompt: setPrompt }),
    [toast, dismiss, dialog, fail],
  );

  return (
    <NotifyContext.Provider value={api}>
      {children}

      <div className="m3-snackbar-host" role="status" aria-live="polite">
        {toasts.map((m) => (
          <div key={m.id} className={`m3-snackbar m3-snackbar--${m.tone}`}>
            {m.tone === "success" && (
              <span className="m3-snackbar__glyph" aria-hidden="true">
                <IconCheck />
              </span>
            )}
            <span className="m3-snackbar__text">
              {m.text}
              {m.count > 1 && <span className="m3-snackbar__count">×{m.count}</span>}
            </span>
            <div className="m3-snackbar__actions">
              {m.action && (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(m.id);
                    m.action!.onClick();
                  }}
                >
                  {m.action.label}
                </button>
              )}
              {m.detail && (
                <button
                  type="button"
                  onClick={() =>
                    void dialog({
                      title: m.text,
                      detail: m.detail,
                      tone: m.tone === "success" ? "neutral" : m.tone,
                      icon: <IconTune />,
                    })
                  }
                >
                  {t("dialog.details")}
                </button>
              )}
              <button type="button" className="m3-snackbar__dismiss" aria-label={t("dialog.close")} onClick={() => dismiss(m.id)}>
                <IconClose />
              </button>
            </div>
          </div>
        ))}

        {prompt && (
          <div className="m3-snackbar m3-snackbar--prompt">
            <span className="m3-snackbar__text">{prompt.text}</span>
            <div className="m3-snackbar__actions">
              {prompt.actions.map((action) => (
                <button key={action.label} type="button" onClick={action.onClick}>
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Only the newest dialog is interactive; earlier ones stay stacked
          behind it so an error raised while one is open is not lost. */}
      {dialogs.map((d, i) => (
        <div key={d.id} className="m3-dialog-layer" data-stacked={i < dialogs.length - 1 ? "" : undefined}>
          <Dialog request={d.request} onResolve={(value) => resolveDialog(d.id, value)} />
        </div>
      ))}
    </NotifyContext.Provider>
  );
}

/**
 * Installs window-level handlers for the two failure classes React cannot
 * see: an `Error` thrown outside a component and a promise nobody awaited.
 * Both used to be silent, which is the worst possible outcome - the app looks
 * fine and simply stops doing the thing that was asked of it.
 */
export function useGlobalFailureHandlers() {
  const { fail } = useNotify();
  const seen = useRef(new Set<string>());

  return useCallback(() => {
    const once = (signature: string) => {
      if (seen.current.has(signature)) return false;
      seen.current.add(signature);
      // Bounded: a leaking loop must not grow this forever.
      if (seen.current.size > 64) seen.current.clear();
      return true;
    };

    const onError = (event: ErrorEvent) => {
      const signature = `${event.message}@${event.filename}:${event.lineno}`;
      if (!once(signature)) return;
      fail(
        isAppError(event.error)
          ? event.error
          : {
              isAppError: true as const,
              code: "app/unhandled" as const,
              severity: "error" as const,
              recovery: "report" as const,
              detail: `${event.message}\n${event.filename}:${event.lineno}:${event.colno}\n${
                event.error?.stack ?? ""
              }`,
              cause: event.error,
            },
        { as: "toast" },
      );
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const detail = shortDetail(String(event.reason), 200);
      if (!once(`reject:${detail}`)) return;
      fail(
        isAppError(event.reason)
          ? event.reason
          : {
              isAppError: true as const,
              code: "app/unhandled" as const,
              severity: "error" as const,
              recovery: "report" as const,
              detail: event.reason instanceof Error ? (event.reason.stack ?? event.reason.message) : String(event.reason),
              cause: event.reason,
            },
        { as: "toast" },
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [fail]);
}
