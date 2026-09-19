import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, describeError } from '../api/errors';
import { usedThisMonth } from '../api/format';
import { useQuery } from '../api/hooks';
import type { Id, SkillSummary } from '../api/types';
import { ErrorNote, Loading } from '../components/bits';
import { Icon } from '../components/Icon';
import { NewSkillDialog } from './skill/NewSkillDialog';
import { RunSheet } from './skill/RunSheet';
import { spaceLabel } from './skill/text';

/** The whole card opens the skill (a stretched link); Run stays a small separate button above it. */
function SkillCard({ skill, onRun }: { skill: SkillSummary; onRun: () => void }) {
  return (
    <li className="card skill">
      <div className="skill__head">
        <span className="skill__icon">
          <Icon name="spark" size={16} />
        </span>
        <Link to={`/skills/${skill.id}`} className="skill__name skill__link">
          {skill.title}
        </Link>
        <span className="mono small-meta skill__space">{spaceLabel(skill)}</span>
      </div>
      <p className="skill__desc">{skill.description || 'No description yet — open it to write one.'}</p>
      <div className="skill__foot">
        <span className="mono small-meta skill__meta">
          v{skill.currentVersion} · {usedThisMonth(skill.runCount30d)}
          {skill.myRole === 'reader' ? ' · you can use' : ''}
        </span>
        <button type="button" className="btn btn--box-sm skill__run" onClick={onRun} aria-label={`Run ${skill.title}`}>
          Run
        </button>
      </div>
    </li>
  );
}

const matches = (s: SkillSummary, q: string): boolean => `${s.title} ${s.slug} ${s.description} ${spaceLabel(s)}`.toLowerCase().includes(q);

/** Skills.dc.html — the library. Every card opens its skill; nothing here is sample data on a server. */
export function Skills() {
  const navigate = useNavigate();
  const skills = useQuery((c) => c.listSkills(), []);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<Id | null>(null);

  // A server without the skills endpoint answers 404: say so, keep the rest of the app working.
  const unavailable = skills.error instanceof ApiError && skills.error.kind === 'not-found';
  const all = skills.data ?? [];
  const query = q.trim().toLowerCase();
  const shown = query ? all.filter((s) => matches(s, query)) : all;

  return (
    <main className="main main--list">
      <div className="titlebar">
        <h1 className="h1 h1--sm">Skills</h1>
        <button type="button" className="btn btn--dark btn--cta" onClick={() => setCreating(true)} disabled={unavailable} title={unavailable ? 'This server has no skills yet' : undefined}>
          <Icon name="plus" size={15} />
          New skill
        </button>
      </div>
      <p className="lede skills__lede">The way your team does things, written once. Open one to read it or change it — every connected tool can pick it up, with the context it needs.</p>

      {unavailable ? (
        <div className="skempty" role="status">
          <h2 className="skempty__title">Skills aren’t available on this server yet</h2>
          <p className="skempty__text">
            Your OpenKT server doesn’t have skills yet. Once it is updated, the skills your team writes show up here and in every connected tool. Everything else in the app works as usual.
          </p>
        </div>
      ) : skills.error ? (
        <ErrorNote error={new Error(describeError(skills.error))} />
      ) : !skills.data ? (
        <Loading />
      ) : all.length === 0 ? (
        <div className="skempty">
          <h2 className="skempty__title">No skills yet</h2>
          <p className="skempty__text">A skill is how your team does one thing — a follow-up email, a pull request, a weekly update — written down once. Write the first one and every connected AI tool can use it.</p>
          <p>
            <button type="button" className="btn btn--pill btn--dark btn--run" onClick={() => setCreating(true)}>
              Write a skill
            </button>
          </p>
        </div>
      ) : (
        <>
          <div className="skills__tools">
            <label className="search">
              <Icon name="search" size={14} />
              <span className="sr-only">Search skills</span>
              <input type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.preventDefault(), setQ(''))} />
            </label>
            {query && (
              <span className="mono small-meta" role="status">
                {shown.length} of {all.length}
              </span>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="empty">No skill matches “{q.trim()}”.</p>
          ) : (
            <ul className="plain skills" aria-label="Skills">
              {shown.map((s) => (
                <SkillCard key={s.id} skill={s} onRun={() => setRunning(s.id)} />
              ))}
            </ul>
          )}
        </>
      )}

      {creating && <NewSkillDialog onClose={() => setCreating(false)} onCreated={(s) => navigate(`/skills/${s.id}/edit`)} />}
      {running && <RunSheet skillId={running} onClose={() => setRunning(null)} />}
    </main>
  );
}
