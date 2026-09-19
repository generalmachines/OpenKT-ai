import { useState } from 'react';
import { useClient, useQuery } from '../api/hooks';
import type { Skill, SkillRun } from '../api/types';
import { ErrorNote, Loading } from '../components/bits';
import { Icon } from '../components/Icon';
import { PreviewBadge } from '../components/PreviewBadge';

function SkillCard({ skill }: { skill: Skill }) {
  const client = useClient();
  const [state, setState] = useState<'idle' | 'running' | SkillRun>('idle');

  const run = async () => {
    setState('running');
    setState(await client.runSkill(skill.id));
  };

  return (
    <li className="card skill">
      <div className="skill__head">
        <span className="skill__icon">
          <Icon name="spark" size={16} />
        </span>
        <span className="skill__name">{skill.name}</span>
        <span className="mono small-meta">{skill.sharedWith}</span>
      </div>
      <p className="skill__desc">{skill.description}</p>
      <div className="skill__foot">
        <span className="mono small-meta skill__meta">{typeof state === 'object' ? `ran on ${state.model}` : skill.meta}</span>
        <button type="button" className="btn btn--box-sm" onClick={run} disabled={state === 'running'}>
          {state === 'running' ? 'Running…' : 'Run'}
        </button>
      </div>
      {typeof state === 'object' && (
        <p className="skill__out mono" role="status">
          {state.output}
        </p>
      )}
    </li>
  );
}

/** Skills.dc.html */
export function Skills() {
  const client = useClient();
  const skills = useQuery((c) => c.listSkills(), []);
  return (
    <main className="main main--list">
      <PreviewBadge area="skills" />
      <div className="titlebar">
        <h1 className="h1 h1--sm">Skills</h1>
        <button type="button" className="btn btn--dark btn--cta" onClick={() => void client.createSkill('Untitled skill')}>
          <Icon name="plus" size={15} />
          New skill
        </button>
      </div>
      <p className="lede" style={{ maxWidth: 600, marginBottom: 12 }}>
        The way your team does things, written once. Run one here on the local model, or let any connected tool pick it up with the context it needs.
      </p>
      {skills.loading && !skills.data && <Loading />}
      {skills.error && <ErrorNote error={skills.error} />}
      <ul className="plain skills">
        {(skills.data ?? []).map((s) => (
          <SkillCard key={s.id} skill={s} />
        ))}
      </ul>
    </main>
  );
}
