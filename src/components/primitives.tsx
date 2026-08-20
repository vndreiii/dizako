import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/* ------------------------------------------------------------------ */
/* Ripple — the M3 state layer + touch ripple                          */
/* ------------------------------------------------------------------ */

interface RippleState {
  key: number;
  x: number;
  y: number;
  size: number;
}

export function useRipple() {
  const [ripples, setRipples] = useState<RippleState[]>([]);
  const seq = useRef(0);

  const spawn = (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    // Radius must reach the furthest corner so the ripple always covers the
    // whole surface regardless of where the pointer landed.
    const size =
      Math.max(
        Math.hypot(e.clientX - rect.left, e.clientY - rect.top),
        Math.hypot(e.clientX - rect.right, e.clientY - rect.top),
        Math.hypot(e.clientX - rect.left, e.clientY - rect.bottom),
        Math.hypot(e.clientX - rect.right, e.clientY - rect.bottom),
      ) * 2;
    const key = seq.current++;
    setRipples((r) => [...r, { key, x: e.clientX - rect.left, y: e.clientY - rect.top, size }]);
    window.setTimeout(() => setRipples((r) => r.filter((v) => v.key !== key)), 550);
  };

  const nodes = ripples.map((r) => (
    <span
      key={r.key}
      className="m3-ripple"
      style={{ left: r.x - r.size / 2, top: r.y - r.size / 2, width: r.size, height: r.size }}
    />
  ));

  return { spawn, nodes };
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = "filled" | "tonal" | "outlined" | "text" | "elevated";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  /** Expressive buttons can stretch to a pill or square depending on context. */
  shape?: "round" | "square";
}

export function Button({
  variant = "filled",
  icon,
  shape = "round",
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const { spawn, nodes } = useRipple();
  return (
    <button
      {...rest}
      onPointerDown={(e) => {
        spawn(e);
        rest.onPointerDown?.(e);
      }}
      className={`m3-btn m3-btn--${variant} m3-btn--${shape} ${className}`}
    >
      {icon && <span className="m3-btn__icon">{icon}</span>}
      {children && <span className="m3-btn__label">{children}</span>}
      {nodes}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Icon button                                                         */
/* ------------------------------------------------------------------ */

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  selected?: boolean;
  variant?: "standard" | "filled" | "tonal";
}

export function IconButton({
  label,
  selected = false,
  variant = "standard",
  children,
  className = "",
  ...rest
}: IconButtonProps) {
  const { spawn, nodes } = useRipple();
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      aria-pressed={rest["aria-pressed"] ?? (selected || undefined)}
      onPointerDown={(e) => {
        spawn(e);
        rest.onPointerDown?.(e);
      }}
      className={`m3-iconbtn m3-iconbtn--${variant} ${selected ? "is-selected" : ""} ${className}`}
    >
      {children}
      {nodes}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Rendered next to the label; defaults to the raw value. */
  display?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
  disabled = false,
}: SliderProps) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={`m3-slider ${disabled ? "is-disabled" : ""}`}>
      <div className="m3-slider__head">
        <label htmlFor={id} className="m3-slider__label">
          {label}
        </label>
        <span className="m3-slider__value">{display ?? value}</span>
      </div>
      <input
        id={id}
        type="range"
        className="m3-slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--m3-slider-pct" as string]: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, description, checked, onChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className={`m3-switchrow ${disabled ? "is-disabled" : ""}`}>
      <div className="m3-switchrow__text">
        <label htmlFor={id} className="m3-switchrow__label">
          {label}
        </label>
        {description && <p className="m3-switchrow__desc">{description}</p>}
      </div>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`m3-switch ${checked ? "is-on" : ""}`}
      >
        <span className="m3-switch__track">
          <span className="m3-switch__thumb" />
        </span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Segmented button                                                    */
/* ------------------------------------------------------------------ */

interface SegmentedProps<T extends string> {
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}

export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="m3-segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          className={`m3-segmented__item ${o.value === value ? "is-selected" : ""}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <span className="m3-segmented__icon">{o.icon}</span>}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Snackbar                                                            */
/* ------------------------------------------------------------------ */

interface SnackbarMessage {
  id: number;
  text: string;
  tone: "neutral" | "error";
}

const SnackbarContext = createContext<(text: string, tone?: "neutral" | "error") => void>(() => {});

export const useSnackbar = () => useContext(SnackbarContext);

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<SnackbarMessage[]>([]);
  const seq = useRef(0);

  const push = (text: string, tone: "neutral" | "error" = "neutral") => {
    const id = seq.current++;
    setQueue((q) => [...q, { id, text, tone }]);
    window.setTimeout(() => setQueue((q) => q.filter((m) => m.id !== id)), 4000);
  };

  return (
    <SnackbarContext.Provider value={push}>
      {children}
      <div className="m3-snackbar-host" role="status" aria-live="polite">
        {queue.map((m) => (
          <div key={m.id} className={`m3-snackbar m3-snackbar--${m.tone}`}>
            {m.text}
          </div>
        ))}
      </div>
    </SnackbarContext.Provider>
  );
}
