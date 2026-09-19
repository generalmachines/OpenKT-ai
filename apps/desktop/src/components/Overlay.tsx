import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Centered box (a small form) or a sheet down the right edge (running a skill). */
  variant?: 'dialog' | 'sheet';
  width?: number;
  /** Something under the title in mono, e.g. the skill's slug. */
  subtitle?: ReactNode;
  /** Announced as an alertdialog: a question that needs an answer (discard changes?). */
  alert?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True while any Overlay is open: global shortcuts (the editor's ⌘S / Esc) stand down. */
export const overlayOpen = (): boolean => typeof document !== 'undefined' && document.querySelector('[data-overlay]') !== null;

/**
 * The one modal surface: scrim, a box, Esc and the scrim close it, focus goes
 * in on open (to `[data-autofocus]` first), stays inside while open, and goes
 * back to where it was on close.
 */
export function Overlay({ title, onClose, children, variant = 'dialog', width, subtitle, alert }: Props) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = box.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('input, textarea, button:not([data-close])');
    (first ?? el)?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab' && box.current) {
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={`modal modal--${variant}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown} data-overlay>
      <div
        ref={box}
        className={`modal__box modal__box--${variant}`}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        style={width ? { width } : undefined}
      >
        <div className="modal__head">
          <div className="modal__titles">
            <h2 id={`${id}-title`} className="modal__title">
              {title}
            </h2>
            {subtitle && <div className="modal__sub mono">{subtitle}</div>}
          </div>
          <button type="button" className="btn btn--round modal__close" onClick={onClose} aria-label="Close" data-close>
            <Icon name="x" size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A question with two answers. `confirm` does the thing; `cancel` keeps things as they are. */
export function Confirm({
  title,
  body,
  confirm,
  cancel = 'Cancel',
  onConfirm,
  onCancel,
  destructive,
}: {
  title: string;
  body: ReactNode;
  confirm: string;
  cancel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  return (
    <Overlay title={title} onClose={onCancel} width={440} alert>
      <div className="modal__body">{body}</div>
      <div className="modal__actions">
        <button type="button" className="btn btn--pill" onClick={onCancel} data-autofocus>
          {cancel}
        </button>
        <button type="button" className={`btn btn--pill ${destructive ? 'btn--danger' : 'btn--dark'}`} onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Overlay>
  );
}
