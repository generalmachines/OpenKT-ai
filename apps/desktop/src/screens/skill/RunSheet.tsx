import { useState } from 'react';
import { localAi } from '../../api/bridge';
import { describeError } from '../../api/errors';
import { useClient, useQuery } from '../../api/hooks';
import type { Id, Skill } from '../../api/types';
import { ErrorNote, Loading } from '../../components/bits';
import { Overlay } from '../../components/Overlay';
import { CopyButton } from './SkillParts';
import { leadOf, mainFile, sectionsOf, skillAsText } from './text';

type RunState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; output: string } | { kind: 'failed'; message: string };

const systemFor = (s: Skill): string =>
  `You are carrying out a skill called "${s.title}". Follow its instructions exactly, using the person's input below them. Answer with the result only.\n\n${skillAsText(s.files)}`;

/**
 * The Run side sheet. Runs on this Mac's model when main offers a chat call;
 * until then it says so plainly and hands over the skill to paste anywhere.
 * A run is recorded on the server only when one really happened.
 */
export function RunSheet({ skillId, onClose }: { skillId: Id; onClose: () => void }) {
  const client = useClient();
  const skill = useQuery((c) => c.getSkill(skillId), [skillId]);
  const [input, setInput] = useState('');
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const canRun = localAi.canChat();
  const s = skill.data;

  const run = async () => {
    if (!s || !canRun || !input.trim() || state.kind === 'running') return;
    setState({ kind: 'running' });
    let output: string;
    try {
      output = await localAi.chat(systemFor(s), input.trim());
    } catch (e) {
      setState({ kind: 'failed', message: describeError(e) });
      return;
    }
    setState({ kind: 'done', output });
    // It ran: count it. The count is not worth an error on screen if the server is unreachable.
    await client.recordSkillRun(s.id).catch(() => undefined);
  };

  return (
    <Overlay title={s ? `Run “${s.title}”` : 'Run skill'} subtitle={s?.slug} variant="sheet" width={480} onClose={onClose}>
      {skill.error ? (
        <div className="run">
          <ErrorNote error={new Error(describeError(skill.error))} />
        </div>
      ) : !s ? (
        <div className="run">
          <Loading />
        </div>
      ) : (
        <div className="run">
          <section className="run__about" aria-label="What this skill does">
            {s.description && <p className="run__desc">{s.description}</p>}
            {leadOf(mainFile(s.files)?.content ?? '') && <p className="run__lead">{leadOf(mainFile(s.files)?.content ?? '')}</p>}
            <p className="run__meta mono">{summaryLine(s)}</p>
          </section>
          <label htmlFor="run-input" className="caps mono run__label">
            Your input
          </label>
          <textarea
            id="run-input"
            className="run__input"
            placeholder="Paste the draft or describe what you need"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="run__actions">
            {canRun ? (
              <>
                <button type="button" className="btn btn--pill btn--dark btn--run" onClick={() => void run()} disabled={!input.trim() || state.kind === 'running'}>
                  {state.kind === 'running' ? 'Running…' : 'Run'}
                </button>
                <CopyButton text={() => skillAsText(s.files, input)} label={input.trim() ? 'Copy skill with your input' : 'Copy skill'} className="btn btn--pill" />
              </>
            ) : (
              <CopyButton text={() => skillAsText(s.files, input)} label={input.trim() ? 'Copy skill with your input' : 'Copy skill'} className="btn btn--pill btn--dark" />
            )}
          </div>
          {!canRun ? (
            <section className="run__result" role="status" aria-label="Result">
              <p>
                Running skills on this Mac arrives with the next build — for now, use this skill from any connected AI tool: it is available there as <code className="mono">{s.slug}</code>.
              </p>
              <p className="run__hint">Or copy it and paste it, with your input, into any chat.</p>
            </section>
          ) : state.kind === 'running' ? (
            <section className="run__result" role="status" aria-label="Result">
              <p>Running on this Mac…</p>
            </section>
          ) : state.kind === 'failed' ? (
            <section className="run__result run__result--error" role="alert" aria-label="Result">
              <p>The model on this Mac couldn’t run it: {state.message}</p>
            </section>
          ) : state.kind === 'done' ? (
            <section className="run__result" aria-label="Result">
              <div className="run__output">{state.output}</div>
              <div>
                <CopyButton text={state.output} label="Copy result" />
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Overlay>
  );
}

function summaryLine(s: Skill): string {
  const sections = sectionsOf(mainFile(s.files)?.content ?? '');
  const refs = s.files.length - 1;
  return [`v${s.currentVersion}`, sections.join(' · '), refs > 0 ? `+ ${refs} reference ${refs === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(' · ');
}
