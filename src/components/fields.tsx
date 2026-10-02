import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconClose, IconDropDown, IconMore, IconSearch } from "./Icons";
import { IconButton } from "./primitives";

/* ------------------------------------------------------------------ */
/* Select - the Material 3 "exposed dropdown menu"                     */
/*                                                                     */
/* A filled text field that opens a menu surface. It replaces the      */
/* native <select>, whose popup is drawn by the operating system's     */
/* toolkit and so can never look like the rest of the app.             */
/* ------------------------------------------------------------------ */

export interface SelectOption {
  value: string;
  label: string;
  /** Items sharing a group are listed together under its heading. */
  group?: string;
  /** Secondary line, shown under the label in the menu. */
  hint?: string;
}

interface SelectProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Text for a group heading, by group id. Omit for no headings. */
  groupLabel?: (group: string) => string;
  /** Leading content in the menu rows, e.g. a sample of the font. */
  renderLeading?: (option: SelectOption) => ReactNode;
  /** Style applied to the displayed value, e.g. a font family preview. */
  valueStyle?: React.CSSProperties;
  disabled?: boolean;
}

interface MenuPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

const MENU_GAP = 4;
const MENU_MARGIN = 12;
const MENU_MAX = 360;

export function Select({
  label,
  value,
  options,
  onChange,
  groupLabel,
  renderLeading,
  valueStyle,
  disabled = false,
}: SelectProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const selected = options.find((o) => o.value === value);

  // Options in menu order: grouped together, groups in first-seen order.
  const ordered = useMemo(() => {
    const groups: string[] = [];
    for (const o of options) {
      const g = o.group ?? "";
      if (!groups.includes(g)) groups.push(g);
    }
    return groups.flatMap((g) => options.filter((o) => (o.group ?? "") === g));
  }, [options]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setActive(-1);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const choose = useCallback(
    (v: string) => {
      onChange(v);
      close();
    },
    [onChange, close],
  );

  const openMenu = useCallback(() => {
    if (disabled) return;
    setActive(Math.max(0, ordered.findIndex((o) => o.value === value)));
    setOpen(true);
  }, [disabled, ordered, value]);

  // Place the menu under the field, or above it when there is no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - MENU_GAP - MENU_MARGIN;
      const above = r.top - MENU_GAP - MENU_MARGIN;
      const flip = below < 220 && above > below;
      const room = flip ? above : below;
      const width = Math.max(r.width, 200);
      setPlacement({
        left: Math.min(Math.max(MENU_MARGIN, r.left), window.innerWidth - width - MENU_MARGIN),
        top: flip ? r.top - MENU_GAP : r.bottom + MENU_GAP,
        width,
        maxHeight: Math.min(MENU_MAX, room),
        above: flip,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Bring the active row into view as the keyboard moves through a long list.
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, placement]);

  // Outside press closes without stealing focus from whatever was pressed.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      // Scrolling the menu itself is not leaving it.
      if (menuRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    const last = ordered.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => Math.min(last, a + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0) choose(ordered[active]!.value);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
      default: {
        // Type-ahead: letters typed in quick succession jump to a match.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = performance.now();
          const t = typed.current;
          t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
          t.at = now;
          const from = t.text.length === 1 ? active + 1 : active;
          const hit = [...ordered.slice(from), ...ordered.slice(0, from)].find((o) =>
            o.label.toLowerCase().startsWith(t.text),
          );
          if (hit) setActive(ordered.indexOf(hit));
        }
      }
    }
  };

  let lastGroup: string | null = null;
  const rows = ordered.map((o, i) => {
    const g = o.group ?? "";
    const heading = g !== lastGroup && groupLabel && g ? groupLabel(g) : null;
    const divider = lastGroup !== null && g !== lastGroup;
    lastGroup = g;
    return (
      <div key={o.value} role="presentation">
        {divider && <div className="m3-menu__divider" role="separator" />}
        {heading && (
          <div className="m3-menu__heading" role="presentation">
            {heading}
          </div>
        )}
        <MenuItem
          option={o}
          index={i}
          domId={`${id}-o${i}`}
          selected={o.value === value}
          active={i === active}
          leading={renderLeading ? renderLeading(o) : null}
          onHover={setActive}
          onPick={choose}
        />
      </div>
    );
  });

  return (
    <div className={`m3-select ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="m3-field m3-select__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-o${active}` : undefined}
        aria-label={`${label}: ${selected?.label ?? ""}`}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="m3-field__label">{label}</span>
        <span className="m3-field__value" style={valueStyle}>
          {selected?.label ?? " "}
        </span>
        <span className="m3-select__arrow" aria-hidden="true">
          <IconDropDown />
        </span>
        <span className="m3-field__state" aria-hidden="true" />
      </button>

      {open &&
        placement &&
        createPortal(
          <div
            ref={menuRef}
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            className={`m3-menu ${placement.above ? "is-above" : ""}`}
            style={{
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              ...(placement.above
                ? { bottom: window.innerHeight - placement.top }
                : { top: placement.top }),
            }}
            onKeyDown={onKeyDown}
          >
            {rows}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface MenuItemProps {
  option: SelectOption;
  index: number;
  domId: string;
  selected: boolean;
  active: boolean;
  leading: ReactNode;
  onHover: (index: number) => void;
  onPick: (value: string) => void;
}

function MenuItem({ option, index, domId, selected, active, leading, onHover, onPick }: MenuItemProps) {
  return (
    <div
      role="option"
      id={domId}
      data-index={index}
      aria-selected={selected}
      className={`m3-menu__item ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
      onPointerEnter={() => onHover(index)}
      onClick={() => onPick(option.value)}
    >
      {leading && <span className="m3-menu__leading">{leading}</span>}
      <span className="m3-menu__text">
        <span className="m3-menu__label">{option.label}</span>
        {option.hint && <span className="m3-menu__hint">{option.hint}</span>}
      </span>
      {selected && (
        <span className="m3-menu__check" aria-hidden="true">
          <IconCheck />
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TextField - filled, with a floating label                           */
/* ------------------------------------------------------------------ */

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Supporting text under the field. */
  supporting?: string;
  multiline?: boolean;
  rows?: number;
  spellCheck?: boolean;
  disabled?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  supporting,
  multiline = false,
  rows = 2,
  spellCheck = false,
  disabled,
}: TextFieldProps) {
  const id = useId();
  const common = {
    id,
    value,
    placeholder: placeholder ?? " ",
    spellCheck,
    disabled,
    "aria-describedby": supporting ? `${id}-s` : undefined,
    className: "m3-field__input",
  };
  return (
    <div className={`m3-textfield ${multiline ? "m3-textfield--multi" : ""} ${disabled ? "is-disabled" : ""}`}>
      <div className="m3-field">
        {multiline ? (
          <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input {...common} type="text" onChange={(e) => onChange(e.target.value)} />
        )}
        <label htmlFor={id} className="m3-field__label">
          {label}
        </label>
        <span className="m3-field__state" aria-hidden="true" />
      </div>
      {supporting && (
        <p id={`${id}-s`} className="m3-textfield__supporting">
          {supporting}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SearchBar                                                           */
/* ------------------------------------------------------------------ */

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  clearLabel: string;
  /** Called on Enter, e.g. to open the first result. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  /** Shown after the field, e.g. a result count. */
  trailing?: ReactNode;
}

/**
 * Material 3 search bar: a full-height pill with a leading search glyph and a
 * clear button that appears once there is something to clear. Escape clears
 * before it does anything else.
 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
  onSubmit,
  autoFocus,
  trailing,
}: SearchBarProps) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={`m3-search ${value ? "has-value" : ""}`} role="search">
      <span className="m3-search__icon" aria-hidden="true">
        <IconSearch />
      </span>
      <input
        ref={ref}
        className="m3-search__input"
        type="search"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          } else if (e.key === "Enter") {
            onSubmit?.();
          }
        }}
      />
      {trailing}
      {value && (
        <button
          type="button"
          className="m3-search__clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ActionMenu - the overflow ("more") menu                             */
/* ------------------------------------------------------------------ */

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Destructive actions read in the error colour. */
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider above this item. */
  divider?: boolean;
  /** A non-interactive heading shown above this item. */
  heading?: string;
  /** Marks the current choice in a group of alternatives. */
  checked?: boolean;
}

interface ActionMenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  actions: MenuAction[];
}

const ACTION_MENU_WIDTH = 272;

/**
 * A button that opens a short menu of actions, right-aligned under it.
 *
 * Arrow keys move, Enter or Space runs the action, Escape closes and hands
 * focus back. Disabled items are skipped by the keyboard but still listed, so
 * the menu keeps one shape whatever is currently possible.
 */
export function ActionMenu({ label, actions }: ActionMenuProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [spot, setSpot] = useState<{ right: number; top: number; bottom: number | null; maxHeight: number } | null>(null);

  const enabled = useMemo(() => actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i >= 0), [actions]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setActive(-1);
    if (refocus) anchorRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - MENU_GAP - MENU_MARGIN;
      const above = r.top - MENU_GAP - MENU_MARGIN;
      const flip = below < 260 && above > below;
      setSpot({
        right: Math.max(MENU_MARGIN, window.innerWidth - r.right),
        top: r.bottom + MENU_GAP,
        bottom: flip ? window.innerHeight - r.top + MENU_GAP : null,
        maxHeight: Math.min(MENU_MAX, flip ? above : below),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && spot) menuRef.current?.focus({ preventScroll: true });
  }, [open, spot]);

  const run = (action: MenuAction) => {
    if (action.disabled) return;
    close();
    action.onSelect();
  };

  const step = (delta: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at < 0 ? (delta === 1 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setActive(enabled[next]!);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(enabled[0] ?? -1);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(enabled[enabled.length - 1] ?? -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const a = actions[active];
      if (a) run(a);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const toggle = () => (open ? close() : setOpen(true));

  return (
    <span ref={anchorRef} className="m3-actionmenu">
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <IconMore />
      </IconButton>
      {open &&
        spot &&
        createPortal(
          <div
            ref={menuRef}
            id={`${id}-menu`}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className="m3-menu m3-menu--actions"
            style={{
              right: spot.right,
              width: ACTION_MENU_WIDTH,
              maxHeight: spot.maxHeight,
              ...(spot.bottom !== null ? { bottom: spot.bottom } : { top: spot.top }),
            }}
            onKeyDown={onKeyDown}
          >
            {actions.map((a, i) => (
              <div key={a.id} role="presentation">
                {a.divider && <div className="m3-menu__divider" role="separator" />}
                {a.heading && (
                  <div className="m3-menu__heading" role="presentation">
                    {a.heading}
                  </div>
                )}
                <div
                  role={a.checked !== undefined ? "menuitemradio" : "menuitem"}
                  aria-checked={a.checked}
                  aria-disabled={a.disabled || undefined}
                  className={`m3-menu__item ${i === active ? "is-active" : ""} ${a.danger ? "is-danger" : ""} ${
                    a.disabled ? "is-disabled" : ""
                  }`}
                  onPointerEnter={() => !a.disabled && setActive(i)}
                  onClick={() => run(a)}
                >
                  {a.icon && <span className="m3-menu__leading m3-menu__leading--icon">{a.icon}</span>}
                  <span className="m3-menu__text">
                    <span className="m3-menu__label">{a.label}</span>
                  </span>
                  {a.checked && (
                    <span className="m3-menu__check" aria-hidden="true">
                      <IconCheck />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
