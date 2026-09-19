import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { describeError } from '../../api/errors';
import { firstName, timeAgo } from '../../api/format';
import { useClient, useQuery } from '../../api/hooks';
import { describeSkillError, filesProblem, frontmatterProblem, isVersionConflict, parseFrontmatter, pathProblem, SKILL_MD } from '../../api/skillFiles';
import type { Skill, SkillFileInput } from '../../api/types';
import { Loading } from '../../components/bits';
import { CodeEditor } from '../../components/CodeEditor';
import { Icon } from '../../components/Icon';
import { Confirm, Overlay, overlayOpen } from '../../components/Overlay';
import { skillDrafts, type SkillDraft } from './drafts';
import { RailFiles, RailPeople, RailUsage, RailVersions, railFiles, SkillHeader, type RailFile } from './SkillParts';
import { SkillMissing } from './SkillView';
import { accessLine, changedFiles, copyText, fileKind, sameFiles, starterFor, who } from './text';

const plain = (files: readonly SkillFileInput[]): SkillFileInput[] => files.map(({ path, content }) => ({ path, content }));

/** `/skills/:id/edit` — loads the skill, then hands it to the editor (readers are sent back to reading). */
export function SkillEdit() {
  const { id = '' } = useParams();
  const skill = useQuery((c) => c.getSkill(id), [id]);
  if (skill.error) return <SkillMissing error={skill.error} />;
  if (!skill.data) {
    return (
      <main className="main main--skill" aria-busy="true">
        <Loading />
      </main>
    );
  }
  if (skill.data.myRole === 'reader') return <Navigate to={`/skills/${id}`} replace />;
  return <SkillEditor key={id} skill={skill.data} />;
}

type Asking = { kind: 'discard'; to: string } | { kind: 'delete'; path: string };
type PathEdit = { mode: 'add' | 'rename'; value: string; error?: string };

/** Where a click would take the app, if it is an in-app link. */
function inAppTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]');
  if (!a || a.closest('[data-overlay]') || a.getAttribute('target') === '_blank') return null;
  const href = a.getAttribute('href') ?? '';
  if (href.startsWith('#/')) return href.slice(1);
  if (href.startsWith('/')) return href;
  return null;
}

/** Skill-Edit.dc.html — the whole folder as a draft; saving makes the next version. */
export function SkillEditor({ skill }: { skill: Skill }) {
  const client = useClient();
  const navigate = useNavigate();
  const me = useQuery((c) => c.getMe(), []);
  const grants = useQuery((c) => c.listGrants({ type: 'skill', id: skill.id }), [skill.id]);
  const [start] = useState<{ draft: SkillDraft; resumed: boolean }>(() => {
    const kept = skillDrafts.get(skill.id);
    if (kept) return { draft: kept, resumed: true };
    const files = plain(skill.files);
    return { draft: { files, baseFiles: files, baseVersion: skill.currentVersion, changeNote: '', active: SKILL_MD }, resumed: false };
  });
  const [files, setFiles] = useState(start.draft.files);
  const [baseFiles, setBaseFiles] = useState(start.draft.baseFiles);
  const [baseVersion, setBaseVersion] = useState(start.draft.baseVersion);
  const [note, setNote] = useState(start.draft.changeNote);
  const [active, setActive] = useState(start.draft.files.some((f) => f.path === start.draft.active) ? start.draft.active : SKILL_MD);
  const [latest, setLatest] = useState<Skill>(skill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(start.resumed ? `Picked up your unsaved changes, started from v${start.draft.baseVersion}.` : null);
  const [conflict, setConflict] = useState<Skill | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [pathEdit, setPathEdit] = useState<PathEdit | null>(null);
  const problemRef = useRef<HTMLDivElement>(null);

  const meId = me.data?.id;
  const dirty = !sameFiles(files, baseFiles);
  const next = baseVersion + 1;
  const current = files.find((f) => f.path === active) ?? files[0]!;
  const main = files.find((f) => f.path === SKILL_MD);
  const fmProblem = main ? frontmatterProblem(main.content) : null;
  const setProblem = filesProblem(files);
  const liveProblem = fmProblem ? `In SKILL.md: ${fmProblem}` : setProblem && setProblem.code !== 'invalid_frontmatter' ? setProblem.message : null;
  // The example is this skill's own block, so it can be pasted — or put back — as is.
  const example = `---\nname: ${latest.slug}\ndescription: ${latest.description || 'What it does, and when to use it.'}\n---`;
  const noBlock = main ? parseFrontmatter(main.content) === null : false;
  const addBlock = () => {
    setFiles((fs) => fs.map((f) => (f.path === SKILL_MD ? { ...f, content: `${example}\n\n${f.content.replace(/^\s+/, '')}` } : f)));
    setActive(SKILL_MD);
  };

  // Every change is kept, so leaving the editor any way at all loses nothing.
  useEffect(() => {
    if (dirty) skillDrafts.set(skill.id, { files, baseFiles, baseVersion, changeNote: note, active });
    else skillDrafts.delete(skill.id);
  }, [dirty, files, baseFiles, baseVersion, note, active, skill.id]);

  const save = async () => {
    if (busy) return;
    if (!dirty) {
      setError('Nothing has changed yet.');
      return;
    }
    // The server would refuse these; the strip under the editor already says why.
    if (filesProblem(files)) {
      setError(null);
      problemRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await client.saveSkill(skill.id, { files, changeNote: note, baseVersion });
      skillDrafts.delete(skill.id);
      navigate(`/skills/${skill.id}`, { state: { notice: `Saved as v${saved.currentVersion}.` } });
    } catch (e) {
      if (isVersionConflict(e)) {
        try {
          const theirs = await client.getSkill(skill.id);
          setLatest(theirs);
          setConflict(theirs);
        } catch {
          setError('Someone saved a newer version while you were editing, and it couldn’t be loaded. Copy your changes, then reopen the skill.');
        }
      } else setError(describeSkillError(e, describeError));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => (dirty ? setAsking({ kind: 'discard', to: `/skills/${skill.id}` }) : navigate(`/skills/${skill.id}`));

  // ⌘S saves and Esc cancels from anywhere on the page, unless a dialog or menu has the key.
  const keys = useRef({ save, cancel });
  keys.current = { save, cancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlayOpen()) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void keys.current.save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        keys.current.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Leaving by an in-app link with unsaved changes asks first. (Any other way out keeps the draft: see drafts.ts.)
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      const to = inAppTarget(e);
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      setAsking({ kind: 'discard', to });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty]);

  const edit = (content: string) => {
    setFiles((fs) => fs.map((f) => (f.path === current.path ? { ...f, content } : f)));
    setError(null);
  };

  const submitPath = (e: FormEvent) => {
    e.preventDefault();
    if (!pathEdit) return;
    const path = pathEdit.value.trim();
    const others = files.map((f) => f.path).filter((p) => pathEdit.mode === 'add' || p !== current.path);
    const bad = pathProblem(path, others);
    if (bad) return setPathEdit({ ...pathEdit, error: bad });
    if (pathEdit.mode === 'add') setFiles((fs) => [...fs, { path, content: starterFor(path) }]);
    else setFiles((fs) => fs.map((f) => (f.path === current.path ? { ...f, path } : f)));
    setActive(path);
    setPathEdit(null);
  };
  const pathKeys = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setPathEdit(null);
    }
  };

  const viewTheirs = () => {
    // The draft stays (it is still dirty): the skill page offers to continue.
    setConflict(null);
    navigate(`/skills/${skill.id}`);
  };
  const keepEditing = async (theirs: Skill) => {
    const mine = changedFiles(files, baseFiles);
    const text = mine.length === 1 ? mine[0]!.content : mine.map((f) => `File: ${f.path}\n\n${f.content}`).join('\n\n---\n\n');
    const copied = await copyText(text);
    const name = who(theirs.versions[0]?.createdBy ?? theirs.owner, meId);
    setBaseFiles(plain(theirs.files));
    setBaseVersion(theirs.currentVersion);
    setConflict(null);
    setError(null);
    setNotice(
      `${copied ? 'Your version is on the clipboard. ' : ''}Saving now makes v${theirs.currentVersion + 1} from what is in the editor — it replaces what ${name === 'you' ? 'you' : name} changed in v${theirs.currentVersion}. Open v${theirs.currentVersion} in Versions to compare.`,
    );
  };

  const railRows: RailFile[] = files.map((f) => {
    const was = baseFiles.find((b) => b.path === f.path);
    if (!was) return { path: f.path, meta: 'new', metaTone: 'edited' };
    if (was.content !== f.content) return { path: f.path, meta: 'edited', metaTone: 'edited' };
    return railFiles([f])[0]!;
  });
  const removed = baseFiles.filter((b) => !files.some((f) => f.path === b.path)).length;

  return (
    <main className="main main--skill">
      <SkillHeader
        skill={latest}
        meta={`editing · your changes become v${next}`}
        access={accessLine(grants.data ?? [], latest, meId)}
        actions={
          <>
            <button type="button" className="btn btn--pill" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="btn btn--pill btn--dark btn--run" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : `Save as v${next}`}
            </button>
          </>
        }
      />
      <div className="skbody">
        <section className="skbody__main" aria-label="Editor">
          <div className="viewer viewer--edit">
            <div className="viewer__head">
              {pathEdit?.mode === 'rename' ? (
                <form className="viewer__rename" onSubmit={submitPath}>
                  <label htmlFor="rename-file" className="sr-only">
                    New path for {current.path}
                  </label>
                  <input
                    id="rename-file"
                    className="pathinput mono"
                    value={pathEdit.value}
                    autoFocus
                    spellCheck={false}
                    aria-invalid={pathEdit.error ? true : undefined}
                    onChange={(e) => setPathEdit({ mode: 'rename', value: e.target.value })}
                    onKeyDown={pathKeys}
                  />
                  <button type="submit" className="minibtn">
                    Rename
                  </button>
                  <button type="button" className="minibtn minibtn--quiet" onClick={() => setPathEdit(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="viewer__path mono">{current.path}</span>
                  {current.path !== SKILL_MD && (
                    <>
                      <button type="button" className="minibtn" onClick={() => setPathEdit({ mode: 'rename', value: current.path })}>
                        Rename
                      </button>
                      <button type="button" className="minibtn" onClick={() => setAsking({ kind: 'delete', path: current.path })}>
                        Delete
                      </button>
                    </>
                  )}
                  <span className="viewer__hint mono">{fileKind(current.path)} · ⌘S saves · Esc cancels</span>
                </>
              )}
            </div>
            {pathEdit?.mode === 'rename' && pathEdit.error && (
              <p className="viewer__strip viewer__strip--problem" role="alert">
                {pathEdit.error}
              </p>
            )}
            {notice && (
              <p className="viewer__strip" role="status">
                {notice}
              </p>
            )}
            <CodeEditor key={current.path} value={current.content} onChange={edit} label={`Edit ${current.path}`} autoFocus={!pathEdit} />
            {(liveProblem || error) && (
              <div className="viewer__strip viewer__strip--problem" ref={problemRef} tabIndex={-1} role="alert">
                <span>{error ?? liveProblem}</span>
                {!error && fmProblem?.endsWith('like this:') && <pre className="mono">{example}</pre>}
                {!error && noBlock && (
                  <span>
                    <button type="button" className="minibtn" onClick={addBlock}>
                      Add it at the top
                    </button>
                  </span>
                )}
              </div>
            )}
            <div className="viewer__foot">
              <label htmlFor="change-note">What changed</label>
              <input id="change-note" type="text" placeholder="One line for your teammates" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </section>
        <aside className="skrail" aria-label="About this skill">
          <RailFiles files={railRows} active={current.path} onPick={(p) => (setActive(p), setPathEdit(null))}>
            {pathEdit?.mode === 'add' ? (
              <form className="skadd" onSubmit={submitPath}>
                <label htmlFor="new-file" className="sr-only">
                  New file path
                </label>
                <input
                  id="new-file"
                  className="pathinput mono"
                  value={pathEdit.value}
                  autoFocus
                  spellCheck={false}
                  placeholder="references/examples.md"
                  aria-invalid={pathEdit.error ? true : undefined}
                  aria-describedby={pathEdit.error ? 'new-file-error' : 'new-file-hint'}
                  onChange={(e) => setPathEdit({ mode: 'add', value: e.target.value })}
                  onKeyDown={pathKeys}
                />
                {pathEdit.error ? (
                  <p id="new-file-error" className="skadd__msg skadd__msg--error" role="alert">
                    {pathEdit.error}
                  </p>
                ) : (
                  <p id="new-file-hint" className="skadd__msg">
                    Enter adds it · Esc cancels
                  </p>
                )}
              </form>
            ) : (
              <button type="button" className="skfile skfile--add" onClick={() => setPathEdit({ mode: 'add', value: 'references/' })}>
                <span className="skfile__icon">
                  <Icon name="plus" size={13} />
                </span>
                <span className="skfile__name">Add a file</span>
              </button>
            )}
            {removed > 0 && (
              <p className="skadd__msg">
                {removed} {removed === 1 ? 'file' : 'files'} removed when you save
              </p>
            )}
          </RailFiles>
          <RailPeople grants={grants.data} skill={latest} meId={meId} />
          <RailVersions skillId={skill.id} versions={latest.versions} current={latest.currentVersion} selected={baseVersion} meId={meId} />
          <RailUsage skill={latest} />
        </aside>
      </div>
      {asking?.kind === 'discard' && (
        <Confirm
          title="Discard your changes?"
          body={<p>Your edits to “{skill.title}” haven’t been saved.</p>}
          confirm="Discard"
          cancel="Keep editing"
          destructive
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            skillDrafts.delete(skill.id);
            setAsking(null);
            setFiles(baseFiles);
            navigate(asking.to);
          }}
        />
      )}
      {asking?.kind === 'delete' && (
        <Confirm
          title={`Delete ${asking.path}?`}
          body={<p>It is removed from the skill when you save v{next}. Until then, Cancel keeps it.</p>}
          confirm="Delete file"
          destructive
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setFiles((fs) => fs.filter((f) => f.path !== asking.path));
            setActive(SKILL_MD);
            setAsking(null);
          }}
        />
      )}
      {conflict && (
        <Overlay title={conflictTitle(conflict, meId)} onClose={() => setConflict(null)} width={500} alert>
          <div className="modal__body">
            <p>
              v{conflict.currentVersion}
              {conflict.versions[0]?.changeNote ? ` — “${conflict.versions[0].changeNote}”` : ''}, saved {conflict.versions[0] ? timeAgo(conflict.versions[0].createdAt) : 'just now'}. Your changes aren’t saved yet.
            </p>
            <p>View theirs to see what changed — your edits wait here until you come back. Or keep editing: your version is copied to the clipboard, and saving builds on theirs.</p>
          </div>
          <div className="modal__actions">
            <button type="button" className="btn btn--pill" onClick={viewTheirs}>
              View theirs
            </button>
            <button type="button" className="btn btn--pill btn--dark" onClick={() => void keepEditing(conflict)} data-autofocus>
              Keep editing
            </button>
          </div>
        </Overlay>
      )}
    </main>
  );
}

function conflictTitle(theirs: Skill, meId: string | undefined): string {
  const by = theirs.versions[0]?.createdBy;
  if (!by) return 'Someone saved a newer version while you were editing';
  if (by.id === meId) return 'You saved a newer version somewhere else while editing here';
  return `${firstName(by.name)} saved a newer version while you were editing`;
}
