import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, describeError } from '../../api/errors';
import { firstName } from '../../api/format';
import { useClient, useQuery } from '../../api/hooks';
import { SKILL_MD } from '../../api/skillFiles';
import type { Skill } from '../../api/types';
import { AccessPanel } from '../../components/AccessPanel';
import { ErrorNote, Loading } from '../../components/bits';
import { Icon } from '../../components/Icon';
import { Confirm, Overlay } from '../../components/Overlay';
import { skillDrafts } from './drafts';
import { RunSheet } from './RunSheet';
import { FileViewer, RailFiles, RailPeople, RailUsage, RailVersions, railFiles, SkillHeader, type ViewMode } from './SkillParts';
import { accessLine, editedLine, versionLine } from './text';

/** Where a skill cannot be shown: gone, never shared, or a server that has no skills yet. */
export function SkillMissing({ error }: { error: Error }) {
  const notFound = error instanceof ApiError && error.kind === 'not-found';
  return (
    <main className="main main--list">
      <nav className="skhead__crumbs mono" aria-label="Breadcrumb">
        <Link to="/skills" className="quiet-link">
          Skills
        </Link>
      </nav>
      {notFound ? (
        <div className="skempty">
          <h1 className="h1 h1--sm">This skill isn’t here</h1>
          <p className="lede">It may have been deleted, or it hasn’t been shared with you. Ask whoever sent you the link to share it with your email address.</p>
          <p>
            <Link to="/skills">Back to skills</Link>
          </p>
        </div>
      ) : (
        <ErrorNote error={new Error(describeError(error))} />
      )}
    </main>
  );
}

export function ShareSheet({ skill, onClose }: { skill: Pick<Skill, 'id' | 'title' | 'slug'>; onClose: () => void }) {
  return (
    <Overlay title={`Share “${skill.title}”`} subtitle={skill.slug} onClose={onClose} width={640}>
      <div className="modal__scroll">
        <AccessPanel resource={{ type: 'skill', id: skill.id }} noun="skill" layout="sheet" />
      </div>
    </Overlay>
  );
}

/** Skill.dc.html — a skill opened: its files, who can use it, its history. `/skills/:id/versions/:n` shows an old version read-only. */
export function SkillView() {
  const { id = '', version: versionParam } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useClient();
  const skill = useQuery((c) => c.getSkill(id), [id]);
  const me = useQuery((c) => c.getMe(), []);
  const grants = useQuery((c) => c.listGrants({ type: 'skill', id }), [id]);
  const viewing = versionParam ? Number(versionParam) : null;
  const old = useQuery((c) => (viewing ? c.getSkillVersion(id, viewing) : Promise.resolve(null)), [id, viewing]);
  const draft = useSyncExternalStore(skillDrafts.subscribe, () => skillDrafts.get(id));
  const [active, setActive] = useState(SKILL_MD);
  const [view, setView] = useState<ViewMode>('read');
  const [sheet, setSheet] = useState<'run' | 'share' | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const passedNotice = (location.state as { notice?: string } | null)?.notice ?? null;
  const [notice, setNotice] = useState(passedNotice);

  useEffect(() => {
    setNotice(passedNotice);
    if (!passedNotice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [passedNotice, location.key]);

  if (skill.error) return <SkillMissing error={skill.error} />;
  if (!skill.data) {
    return (
      <main className="main main--skill" aria-busy="true">
        <Loading />
      </main>
    );
  }

  const s = skill.data;
  if (viewing !== null && (!Number.isInteger(viewing) || viewing === s.currentVersion)) return <Navigate to={`/skills/${id}`} replace />;

  const meId = me.data?.id;
  const canEdit = s.myRole !== 'reader';
  const isOwner = s.myRole === 'owner';
  const files = viewing ? old.data : s.files;
  const shown = files?.find((f) => f.path === active) ?? files?.find((f) => f.path === SKILL_MD) ?? files?.[0];
  const viewed = viewing ? s.versions.find((v) => v.version === viewing) : undefined;

  const restore = async () => {
    if (!viewing || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const restored = await client.restoreSkillVersion(id, viewing);
      navigate(`/skills/${id}`, { state: { notice: `Restored v${viewing} as v${restored.currentVersion}.` } });
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    try {
      await client.deleteSkill(id);
      skillDrafts.delete(id);
      navigate('/skills', { replace: true });
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  return (
    <main className="main main--skill">
      <SkillHeader
        skill={s}
        meta={editedLine(s, meId)}
        access={accessLine(grants.data ?? [], s, meId)}
        actions={
          <>
            {isOwner && (
              <button type="button" className="btn btn--pill" onClick={() => setSheet('share')}>
                <Icon name="users" size={15} />
                Share
              </button>
            )}
            {canEdit && !viewing && (
              <button type="button" className="btn btn--pill" onClick={() => navigate(`/skills/${id}/edit`)}>
                Edit
              </button>
            )}
            <button type="button" className="btn btn--pill btn--dark btn--run" onClick={() => setSheet('run')}>
              Run
            </button>
            {isOwner && (
              <div className="select-root">
                <button type="button" className="btn btn--round" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                  <Icon name="more" size={16} />
                </button>
                {menu && (
                  <ul className="menu menu--right" role="menu" onMouseLeave={() => setMenu(false)}>
                    <li className="menu__item is-destructive" role="menuitem" onClick={() => (setMenu(false), setConfirmDelete(true))}>
                      Delete skill
                    </li>
                  </ul>
                )}
              </div>
            )}
          </>
        }
      />
      {!canEdit && <p className="sknote">You can use this skill. Ask {firstName(s.owner.name)} for edit access.</p>}
      {notice && (
        <p className="sknote sknote--ok" role="status">
          <Icon name="check" size={13} />
          {notice}
        </p>
      )}
      {problem && (
        <p className="sknote sknote--error" role="alert">
          {problem}
        </p>
      )}
      {viewing && (
        <div className="skbar skbar--version" role="region" aria-label={`Viewing v${viewing}`}>
          <span className="skbar__text">
            <strong>Viewing v{viewing}</strong>
            {viewed && <span className="skbar__sub"> — {versionLine(viewed, meId)}</span>}
          </span>
          {canEdit && (
            <button type="button" className="btn btn--pill-sm btn--dark" onClick={() => void restore()} disabled={busy}>
              {busy ? 'Restoring…' : 'Restore this version'}
            </button>
          )}
          <Link to={`/skills/${id}`} className="btn btn--pill-sm skbar__back">
            Back to v{s.currentVersion}
          </Link>
        </div>
      )}
      {draft && canEdit && !viewing && (
        <div className="skbar" role="region" aria-label="Unsaved changes">
          <span className="skbar__text">You have unsaved changes to this skill, started from v{draft.baseVersion}.</span>
          <button type="button" className="btn btn--pill-sm" onClick={() => skillDrafts.delete(id)}>
            Discard
          </button>
          <button type="button" className="btn btn--pill-sm btn--dark" onClick={() => navigate(`/skills/${id}/edit`)}>
            Continue editing
          </button>
        </div>
      )}
      <div className="skbody">
        <section className="skbody__main" aria-label="File">
          {old.error && viewing ? <ErrorNote error={new Error(describeError(old.error))} /> : shown && files ? <FileViewer file={shown} paths={files.map((f) => f.path)} view={view} onView={setView} onOpenFile={setActive} /> : <Loading />}
        </section>
        <aside className="skrail" aria-label="About this skill">
          <RailFiles files={railFiles(files ?? [])} active={shown?.path ?? ''} onPick={setActive} />
          <RailPeople grants={grants.data} skill={s} meId={meId} />
          <RailVersions skillId={id} versions={s.versions} current={s.currentVersion} selected={viewing ?? s.currentVersion} meId={meId} />
          <RailUsage skill={s} />
        </aside>
      </div>
      {sheet === 'run' && <RunSheet skillId={id} onClose={() => setSheet(null)} />}
      {sheet === 'share' && <ShareSheet skill={s} onClose={() => setSheet(null)} />}
      {confirmDelete && (
        <Confirm
          title={`Delete “${s.title}”?`}
          body={<p>It disappears for everyone it was shared with, and from every connected tool. Its versions go with it.</p>}
          confirm="Delete skill"
          destructive
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </main>
  );
}
