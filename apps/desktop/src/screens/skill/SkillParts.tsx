/**
 * The pieces Skill.dc.html and Skill-Edit.dc.html share: the header (crumbs,
 * title, meta line), the right rail (files, who can use it, versions, usage)
 * and the file viewer with its Read | Source toggle.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { usedThisMonth } from '../../api/format';
import { formatBytes, parseFrontmatter } from '../../api/skillFiles';
import type { Grant, Id, SkillFileInput, SkillSummary, SkillVersion } from '../../api/types';
import { Avatar } from '../../components/bits';
import { CodeEditor } from '../../components/CodeEditor';
import { Icon } from '../../components/Icon';
import { Markdown, resolveSkillPath } from '../../components/Markdown';
import { copyText, railRole, spaceLabel, versionLine } from './text';

export function SkillHeader({ skill, meta, access, actions }: { skill: SkillSummary; meta: string; access?: string; actions: ReactNode }) {
  return (
    <>
      <nav className="skhead__crumbs mono" aria-label="Breadcrumb">
        <Link to="/skills" className="quiet-link">
          Skills
        </Link>
        <Icon name="chev" size={11} />
        {skill.spaceId ? (
          <Link to={`/spaces/${skill.spaceId}`} className="quiet-link">
            {spaceLabel(skill)}
          </Link>
        ) : (
          <span>{spaceLabel(skill)}</span>
        )}
      </nav>
      <div className="skhead__row">
        <h1 className="h1 h1--skill">{skill.title}</h1>
        {actions}
      </div>
      <div className="skhead__meta mono">
        <span>{meta}</span>
        {access && (
          <span className="with-icon">
            <Icon name="lock" size={12} />
            {access}
          </span>
        )}
      </div>
    </>
  );
}

// ── rail ────────────────────────────────────────────────────────────────

export interface RailFile {
  path: string;
  /** "1.1 KB", or "edited" / "new" while editing. */
  meta: string;
  metaTone?: 'edited';
}

export const railFiles = (files: readonly (SkillFileInput & { bytes?: number })[]): RailFile[] =>
  files.map((f) => ({ path: f.path, meta: formatBytes(f.bytes ?? new TextEncoder().encode(f.content).length) }));

export function RailFiles({ files, active, onPick, children }: { files: RailFile[]; active: string; onPick: (path: string) => void; children?: ReactNode }) {
  return (
    <section className="skrail__sec" aria-label="Files">
      <h2 className="caps mono">Files</h2>
      <ul className="plain">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className={`skfile${f.path === active ? ' is-active' : ''}`} aria-current={f.path === active ? 'true' : undefined} onClick={() => onPick(f.path)}>
              <span className="skfile__icon">
                <Icon name="note" size={13} />
              </span>
              <span className="skfile__name mono" title={f.path}>
                {f.path}
              </span>
              <span className={`skfile__meta mono${f.metaTone ? ' is-edited' : ''}`}>{f.meta}</span>
            </button>
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}

/** "Who can use it". A reader usually cannot list grants; then the owner is the one row we know. */
export function RailPeople({ grants, skill, meId }: { grants: Grant[] | undefined; skill: SkillSummary; meId: Id | undefined }) {
  const rows: { key: string; initials: string; name: string; role: string }[] = grants?.length
    ? grants.map((g) => ({ key: g.id, initials: g.pending ? '@' : g.subject.initials, name: g.subject.id === meId ? `${g.subject.name} (you)` : g.subject.name, role: railRole(g) }))
    : [{ key: 'owner', initials: initials(skill.owner.name), name: skill.owner.id === meId ? `${skill.owner.name} (you)` : skill.owner.name, role: 'owner' }];
  return (
    <section className="skrail__sec" aria-label="Who can use it">
      <h2 className="caps mono">Who can use it</h2>
      <ul className="plain">
        {rows.map((r) => (
          <li key={r.key} className="skwho">
            <Avatar initials={r.initials} size={26} fontSize={10.5} style={{ fontWeight: 400 }} />
            <span className="skwho__name">{r.name}</span>
            <span className="skwho__role mono">{r.role}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

const SHOWN_VERSIONS = 5;

/** Newest first. The current version links to the skill; older ones open read-only. */
export function RailVersions({ skillId, versions, current, selected, meId }: { skillId: Id; versions: SkillVersion[]; current: number; selected: number; meId: Id | undefined }) {
  const [all, setAll] = useState(false);
  const selectedIndex = versions.findIndex((v) => v.version === selected);
  const shown = all || selectedIndex >= SHOWN_VERSIONS ? versions : versions.slice(0, SHOWN_VERSIONS);
  return (
    <section className="skrail__sec" aria-label="Versions">
      <h2 className="caps mono">Versions</h2>
      <ul className="plain">
        {shown.map((v) => (
          <li key={v.version}>
            <Link
              to={v.version === current ? `/skills/${skillId}` : `/skills/${skillId}/versions/${v.version}`}
              className={`skver${v.version === selected ? ' is-on' : ''}`}
              aria-current={v.version === selected ? 'page' : undefined}
              aria-label={`v${v.version}${v.version === current ? ' (current)' : ''} — ${versionLine(v, meId)}`}
            >
              <span className="skver__n mono">v{v.version}</span>
              <span className="skver__text">{versionLine(v, meId)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {shown.length < versions.length && (
        <button type="button" className="linkbtn skrail__more" onClick={() => setAll(true)}>
          Show all {versions.length} versions
        </button>
      )}
    </section>
  );
}

export function RailUsage({ skill }: { skill: SkillSummary }) {
  return (
    <p className="skrail__usage mono">
      {usedThisMonth(skill.runCount30d)} · available in every connected tool as {skill.slug}
    </p>
  );
}

// ── file viewer ─────────────────────────────────────────────────────────

export type ViewMode = 'read' | 'source';

export function CopyButton({ text, label = 'Copy', className = 'minibtn' }: { text: string | (() => string); label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };
  return (
    <button type="button" className={className} onClick={() => void onClick()}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : label}</span>
    </button>
  );
}

const isMarkdown = (path: string) => /\.md$/i.test(path);

/** Skill.dc.html's file box: Read renders markdown (frontmatter as a quiet header), Source is the raw text. */
export function FileViewer({ file, paths, view, onView, onOpenFile }: { file: SkillFileInput; paths: string[]; view: ViewMode; onView: (v: ViewMode) => void; onOpenFile: (path: string) => void }) {
  const md = isMarkdown(file.path);
  const fm = md ? parseFrontmatter(file.content) : null;
  const body = fm ? fm.body : file.content;
  const fileFor = (href: string) => {
    const p = resolveSkillPath(file.path, href);
    return p && paths.includes(p) ? p : null;
  };
  return (
    <div className="viewer">
      <div className="viewer__head">
        <span className="viewer__path mono">{file.path}</span>
        {view === 'source' && <CopyButton text={file.content} />}
        <div className="seg" role="group" aria-label="View as">
          <button type="button" className="seg__btn" aria-pressed={view === 'read'} onClick={() => onView('read')}>
            Read
          </button>
          <button type="button" className="seg__btn" aria-pressed={view === 'source'} onClick={() => onView('source')}>
            Source
          </button>
        </div>
      </div>
      {view === 'source' ? (
        <CodeEditor value={file.content} readOnly label={`Source of ${file.path}`} />
      ) : (
        <div className="viewer__body" data-testid="skill-read">
          {fm && fm.fields.length > 0 && (
            <dl className="fm">
              {fm.fields.map((f) => (
                <div key={f.key} className="fm__row">
                  <dt className="mono">{f.key}</dt>
                  <dd className={f.key === 'name' ? 'mono fm__name' : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {!body.trim() ? (
            <p className="empty">This file is empty.</p>
          ) : md ? (
            <Markdown source={body} fileFor={fileFor} onOpenFile={onOpenFile} />
          ) : (
            <pre className="viewer__plain mono">{file.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}
