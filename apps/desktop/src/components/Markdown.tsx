import { Fragment, type ReactNode } from 'react';

/**
 * A small markdown reader for skill files: headings, paragraphs, lists (nested),
 * fenced code, quotes, tables, rules, and inline code / bold / italic / links.
 * It builds React elements — never HTML strings — so a file cannot inject markup.
 */

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'rule' };

const LIST_ITEM = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/;
const isRule = (l: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
const isTableRule = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string): string[] =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
const indentOf = (l: string) => /^\s*/.exec(l)![0].length;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i += 1;
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const base = first[1]!.length;
      const ordered = /\d/.test(first[2]!);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = LIST_ITEM.exec(l);
        if (m && m[1]!.length <= base + 1 && /\d/.test(m[2]!) === ordered) {
          items.push([m[3]!]);
          i += 1;
        } else if (l.trim() && indentOf(l) > base && items.length) {
          items[items.length - 1]!.push(l.slice(Math.min(indentOf(l), base + 2)));
          i += 1;
        } else if (!l.trim() && i + 1 < lines.length && lines[i + 1]!.trim() && (indentOf(lines[i + 1]!) > base || LIST_ITEM.exec(lines[i + 1]!)?.[1]!.length === base)) {
          if (indentOf(lines[i + 1]!) > base) items[items.length - 1]!.push('');
          i += 1;
        } else break;
      }
      blocks.push({ type: 'list', ordered, start: ordered ? Number(/\d+/.exec(first[2]!)![0]) : 1, items: items.map((it) => parseMarkdown(it.join('\n'))) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim() || /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_ITEM.test(l) || isRule(l)) break;
      para.push(l.trim());
      i += 1;
    }
    blocks.push({ type: 'para', text: para.join(' ') });
  }
  return blocks;
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|<(https?:\/\/[^>\s]+)>/g;

const isExternal = (href: string) => /^(https?:|mailto:)/i.test(href);

/** "references/voice.md" from a link written inside `from` ("SKILL.md", "references/examples.md"). Null when it leaves the skill. */
export function resolveSkillPath(from: string, href: string): string | null {
  const clean = href.split('#')[0]!.split('?')[0]!;
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '.' || !seg) continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

interface LinkContext {
  /** Returns true when `href` names another file of the same skill; clicking then opens it. */
  fileFor?: (href: string) => string | null;
  onOpenFile?: (path: string) => void;
}

function inline(text: string, ctx: LinkContext, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}${n++}`;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{inline(m[3] ?? m[4]!, ctx, `${key}-`)}</strong>);
    else if (m[5] !== undefined) {
      const href = m[6]!;
      const file = ctx.fileFor?.(href) ?? null;
      if (isExternal(href))
        out.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {inline(m[5], ctx, `${key}-`)}
          </a>,
        );
      else if (file && ctx.onOpenFile)
        out.push(
          <a
            key={key}
            href={`#${file}`}
            onClick={(e) => {
              e.preventDefault();
              ctx.onOpenFile!(file);
            }}
          >
            {inline(m[5], ctx, `${key}-`)}
          </a>,
        );
      else out.push(<Fragment key={key}>{inline(m[5], ctx, `${key}-`)}</Fragment>);
    } else if (m[7] !== undefined) out.push(<em key={key}>{inline(m[7], ctx, `${key}-`)}</em>);
    else if (m[8] !== undefined)
      out.push(
        <a key={key} href={m[8]} target="_blank" rel="noreferrer noopener">
          {m[8]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderBlocks(blocks: Block[], ctx: LinkContext, tight = false): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'heading': {
        // The file's `#` is the page's second level: the skill title is the h1.
        const Tag = `h${Math.min(6, b.level + 1)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return <Tag key={i}>{inline(b.text, ctx)}</Tag>;
      }
      case 'para':
        return tight && blocks.length === 1 ? <Fragment key={i}>{inline(b.text, ctx)}</Fragment> : <p key={i}>{inline(b.text, ctx)}</p>;
      case 'code':
        return (
          <pre key={i} className="mono" data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.blocks, ctx)}</blockquote>;
      case 'rule':
        return <hr key={i} />;
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{renderBlocks(it, ctx, true)}</li>);
        return b.ordered ? (
          <ol key={i} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={i} className="md__table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j}>{inline(c, ctx)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_h, k) => (
                      <td key={k}>{inline(r[k] ?? '', ctx)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ source, fileFor, onOpenFile }: { source: string } & LinkContext) {
  return <div className="md">{renderBlocks(parseMarkdown(source), { fileFor, onOpenFile })}</div>;
}
