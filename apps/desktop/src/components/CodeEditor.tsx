import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Accessible name of the textarea. */
  label: string;
  onSave?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}

const INDENT = '  ';

/**
 * Skill-Edit.dc.html — a plain textarea with a line-number gutter that scrolls
 * with it. Tab indents (two spaces), Shift-Tab outdents; ⌘S and Esc go to
 * `onSave` / `onCancel` when given, else on to the page. No editor library:
 * skills are short text files and the textarea already knows undo, selection
 * and the system spell checker.
 */
export function CodeEditor({ value, onChange, readOnly, label, onSave, onCancel, autoFocus }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const [lineCount, setLineCount] = useState(() => value.split('\n').length);

  useLayoutEffect(() => {
    setLineCount(value.split('\n').length);
    if (pendingSelection.current && area.current) {
      area.current.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = null;
    }
  }, [value]);

  const syncScroll = () => {
    if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onSave && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === 'Escape') {
      if (!onCancel) return;
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'Tab' && !readOnly && onChange) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      if (e.shiftKey) {
        // Outdent the current line by up to one indent.
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lead = /^ {1,2}/.exec(value.slice(lineStart))?.[0].length ?? 0;
        if (!lead) return;
        pendingSelection.current = [Math.max(lineStart, start - lead), Math.max(lineStart, end - lead)];
        onChange(value.slice(0, lineStart) + value.slice(lineStart + lead));
      } else {
        pendingSelection.current = [start + INDENT.length, start + INDENT.length];
        onChange(value.slice(0, start) + INDENT + value.slice(end));
      }
    }
  };

  const gutterWidth = `${Math.max(2, String(lineCount).length)}ch`;
  return (
    <div className={`code${readOnly ? ' code--read' : ''}`}>
      <div ref={gutter} className="code__gutter mono" aria-hidden="true" style={{ minWidth: `calc(${gutterWidth} + 26px)` }}>
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <textarea
        ref={area}
        className="code__text mono"
        aria-label={label}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        autoFocus={autoFocus}
        onChange={(e) => onChange?.(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
