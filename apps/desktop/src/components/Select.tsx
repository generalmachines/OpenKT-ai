import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  /** Rendered after a hairline, in the accent colour (e.g. "Remove access"). */
  destructive?: boolean;
}

interface Props<V extends string> {
  value: V | null;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  /** Accessible name, e.g. "Role for Ana Reyes". */
  label: string;
  /** Overrides the text on the button (Models uses a constant "Change"). */
  display?: ReactNode;
  variant?: 'box' | 'pill';
  muted?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  style?: CSSProperties;
  align?: 'left' | 'right';
  /** Open upward — used by the capture sheets that sit at the bottom of the screen. */
  up?: boolean;
}

/** The mocks' dropdown button, made to work: a listbox with keyboard support. */
export function Select<V extends string>({
  value,
  options,
  onChange,
  label,
  display,
  variant = 'box',
  muted,
  disabled,
  leading,
  style,
  align = 'right',
  up,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (o: SelectOption<V>) => {
    setOpen(false);
    if (o.value !== value) onChange(o.value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[cursor];
      if (o) pick(o);
    }
  };

  return (
    <div className="select-root" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`select select--${variant}${muted ? ' is-muted' : ''}`}
        style={style}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? ''}`}
        disabled={disabled}
        onClick={() => {
          setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
          setOpen((v) => !v);
        }}
      >
        {leading}
        <span className="select__label">{display ?? current?.label ?? ''}</span>
        <Icon name="down" size={variant === 'pill' ? 12 : 13} />
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className={`menu menu--${align}${up ? ' menu--up' : ''}`}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`menu__item${i === cursor ? ' is-cursor' : ''}${o.destructive ? ' is-destructive' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(o)}
            >
              <span>{o.label}</span>
              {o.value === value && <Icon name="check" size={13} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
