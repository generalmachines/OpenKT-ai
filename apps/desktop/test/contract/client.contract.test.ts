// @vitest-environment node
/**
 * ONE behavioural suite, run against both adapters. It only speaks the app's
 * words (space, session, context, grant) through `OpenKTClient`, so whatever
 * passes here is what the screens can rely on regardless of the data source.
 *   mock — src/api/mock, seeded from the design canvas
 *   http — src/api/http against msw handlers that mirror the real server (test/support/fake-server.ts)
 * The same flow runs against a real server in test/live/server.live.test.ts.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OpenKTClient } from '../../src/api/client';
import { ApiError } from '../../src/api/errors';
import { HttpClient } from '../../src/api/http';
import { MockClient } from '../../src/api/mock';
import { MAX_FILE_BYTES, MAX_FILES, parseFrontmatter } from '../../src/api/skillFiles';
import { createFakeServer } from '../support/fake-server';

const BASE = 'http://openkt.test';
const fake = createFakeServer(BASE);
const server = setupServer(...fake.handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const adapters: [string, () => OpenKTClient][] = [
  ['mock', () => new MockClient()],
  ['http', () => new HttpClient({ baseUrl: BASE, token: fake.tokens.a })],
];

describe.each(adapters)('OpenKTClient behaviour — %s adapter', (kind, make) => {
  it('knows who is signed in', async () => {
    const me = await make().getMe();
    expect(me.id).toBeTruthy();
    expect(me.name).toMatch(/Pratham/);
    expect(me.initials).toMatch(/^[A-Z]{1,2}$/);
    expect((await make().getWorkspace()).me.id).toBe(me.id);
  });

  it('lists spaces with exactly one personal space, and can open each', async () => {
    const client = make();
    const spaces = await client.listSpaces();
    expect(spaces.filter((s) => s.personal)).toHaveLength(1);
    expect(spaces.length).toBeGreaterThan(1);
    for (const s of spaces) expect((await client.getSpace(s.id)).name).toBe(s.name);
  });

  it('new note: the session appears first in my list with its turn, context and summary', async () => {
    const client = make();
    let notified = 0;
    client.subscribe(() => (notified += 1));
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const before = (await client.getSpace(space.id)).sessionCount;

    const text = 'Quote Northgate per store. Send the revised deck on Friday.';
    const session = await client.createSession({ source: 'note', title: 'Pricing thoughts', spaceId: space.id, text });
    expect(session).toMatchObject({ source: 'note', title: 'Pricing thoughts', status: 'open', spaceId: space.id });
    expect(session.turns.map((t) => t.text)).toEqual([text]);

    const f1 = await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Quote Northgate per store', kind: 'decision' });
    await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Send the revised deck on Friday', kind: 'action' });
    expect(f1).toMatchObject({ statement: 'Quote Northgate per store', kind: 'decision', sessionId: session.id });

    const closed = await client.closeSession(session.id, 'Per-store pricing; deck on Friday.');
    expect(closed).toMatchObject({ status: 'closed', summary: 'Per-store pricing; deck on Friday.' });
    expect(notified).toBeGreaterThanOrEqual(4);

    const me = await client.getMe();
    const mine = await client.listSessions({ mine: true });
    expect(mine.find((s) => s.id === session.id)).toMatchObject({ authorId: me.id, status: 'closed', title: 'Pricing thoughts' });
    expect((await client.listSessions({ spaceId: space.id })).map((s) => s.id)).toContain(session.id);
    expect((await client.getSpace(space.id)).sessionCount).toBe(before + 1);

    expect((await client.getSession(session.id)).turns).toHaveLength(1);
    const context = await client.listContext(session.id);
    expect(context.map((c) => [c.kind, c.statement])).toEqual([
      ['decision', 'Quote Northgate per store'],
      ['action', 'Send the revised deck on Friday'],
    ]);
    expect(context.every((c) => c.author === me.name && c.spaceId === space.id)).toBe(true);
  });

  it('recall finds saved context and links to its session; a deleted fact is gone', async () => {
    const client = make();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const session = await client.createSession({ source: 'note', title: 'Warehouse', spaceId: space.id, text: 'x' });
    const fact = await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'The Zanzibar warehouse ships on Thursdays only', kind: 'fact' });

    const hits = await client.recall('zanzibar warehouse', { spaceId: space.id });
    expect(hits.find((h) => h.id === fact.id)).toMatchObject({ type: 'context', kind: 'fact', title: fact.statement, href: `/sessions/${session.id}/context` });

    await client.deleteFact(fact.id);
    expect((await client.recall('zanzibar warehouse', { spaceId: space.id })).some((h) => h.id === fact.id)).toBe(false);
    expect(await client.listContext(session.id)).toEqual([]);
  });

  it.each(['session', 'space', 'skill'] as const)('grants on a %s: owner listed, invite → change role → remove', async (type) => {
    const client = make();
    const me = await client.getMe();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const id =
      type === 'space'
        ? space.id
        : type === 'skill'
          ? (await client.createSkill({ title: `Shared skill ${kind}`, spaceId: space.id })).id
          : (await client.createSession({ source: 'note', title: 'Shared', spaceId: space.id })).id;
    const resource = { type, id };

    const initial = await client.listGrants(resource);
    expect(initial.find((g) => g.subject.id === me.id)).toMatchObject({ role: 'owner' });

    // A teammate who already has an account, invited by email: the row carries their name and email, never an id.
    const email = kind === 'mock' ? 'ana@example.com' : 'ana@openkt.test';
    const invited = await client.inviteByEmail(resource, email, 'reader');
    expect(invited).toMatchObject({ role: 'reader', subject: { name: 'Ana Reyes', email } });
    expect(invited.pending).toBeFalsy();
    const ana = (await client.listGrants(resource)).find((g) => g.subject.email === email)?.subject;
    expect(ana).toMatchObject({ name: 'Ana Reyes', email });

    await client.putGrant(resource, ana!, 'editor');
    const after = (await client.listGrants(resource)).filter((g) => g.subject.id === ana!.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.role).toBe('editor');

    await client.deleteGrant(resource, ana!);
    expect((await client.listGrants(resource)).some((g) => g.subject.id === ana!.id)).toBe(false);
  });

  it.each(['space', 'skill'] as const)('sharing a %s with someone who has no account yet is a pending invitation, shown by email, that can be withdrawn', async (type) => {
    const client = make();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const resource = { type, id: type === 'space' ? space.id : (await client.createSkill({ title: `Pending share ${kind}` })).id };
    const email = `newcomer-${type}-${kind}@elsewhere.test`;

    const grant = await client.inviteByEmail(resource, email, 'editor');
    expect(grant).toMatchObject({ pending: true, role: 'editor', subject: { name: email, email } });

    const listed = (await client.listGrants(resource)).find((g) => g.subject.email === email);
    expect(listed).toMatchObject({ pending: true, role: 'editor', subject: { name: email } });

    await client.putGrant(resource, listed!.subject, 'reader');
    expect((await client.listGrants(resource)).filter((g) => g.subject.email === email).map((g) => [g.role, g.pending])).toEqual([['reader', true]]);

    await client.deleteGrant(resource, listed!.subject);
    expect((await client.listGrants(resource)).some((g) => g.subject.email === email)).toBe(false);
  });

  // ── teams: create, share, move, join ──────────────────────────────────

  it('creates a space from a name: slugged, owned by me, listed, and a second one with that name gets -2', async () => {
    const client = make();
    const me = await client.getMe();
    let notified = 0;
    client.subscribe(() => (notified += 1));
    const name = `Launch plan ${kind}`;

    const space = await client.createSpace({ name, description: 'Everything for the Q4 launch' });
    expect(space).toMatchObject({ name, slug: `launch-plan-${kind}`, personal: false, myRole: 'owner', ownerId: me.id, sessionCount: 0, description: 'Everything for the Q4 launch' });
    expect(notified).toBeGreaterThanOrEqual(1);
    expect((await client.listSpaces()).find((s) => s.id === space.id)).toMatchObject({ name, slug: `launch-plan-${kind}`, myRole: 'owner' });
    expect(await client.getSpace(space.id)).toMatchObject({ id: space.id, name, myRole: 'owner' });

    const again = await client.createSpace({ name });
    expect(again.slug).toBe(`launch-plan-${kind}-2`);
    expect(again.id).not.toBe(space.id);
    await expect(client.createSpace({ name: '   ' })).rejects.toMatchObject({ name: 'ApiError', kind: 'invalid' });
  });

  it('a new space shared by email: a known person is a member with their role, an unknown email waits as an invitation', async () => {
    const client = make();
    const me = await client.getMe();
    const space = await client.createSpace({ name: `Team room ${kind}` });
    expect((await client.listSpaceMembers(space.id)).members).toEqual([expect.objectContaining({ id: me.id, role: 'owner', you: true })]);

    const email = kind === 'mock' ? 'ana@example.com' : 'ana@openkt.test';
    await client.inviteByEmail({ type: 'space', id: space.id }, email, 'editor');
    await client.inviteByEmail({ type: 'space', id: space.id }, `later-${kind}@elsewhere.test`, 'reader');

    const { members, complete } = await client.listSpaceMembers(space.id);
    expect(complete).toBe(true);
    expect(members.map((m) => [m.name, m.role, Boolean(m.pending), Boolean(m.you)])).toEqual([
      [me.name, 'owner', false, true],
      ['Ana Reyes', 'editor', false, false],
      [`later-${kind}@elsewhere.test`, 'reader', true, false],
    ]);
    expect((await client.getSpace(space.id)).memberCount).toBe(2);
  });

  it('the context in a space comes newest first, each with who saved it', async () => {
    const client = make();
    const me = await client.getMe();
    const space = await client.createSpace({ name: `Context list ${kind}` });
    expect(await client.listSpaceContext(space.id)).toEqual([]);
    const session = await client.createSession({ source: 'note', title: 'Kickoff', spaceId: space.id, text: 'x' });
    await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'First: the demo runs on the hosted server', kind: 'decision' });
    await new Promise((r) => setTimeout(r, 5));
    await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Second: capture stays on the Mac', kind: 'fact' });

    const items = await client.listSpaceContext(space.id);
    expect(items.map((c) => [c.statement, c.author, c.authorId, c.sessionId])).toEqual([
      ['Second: capture stays on the Mac', me.name, me.id, session.id],
      ['First: the demo runs on the hosted server', me.name, me.id, session.id],
    ]);
    expect(await client.listSpaceContext(space.id, { limit: 1 })).toHaveLength(1);
    expect((await client.listSessions({ spaceId: space.id }))[0]).toMatchObject({ id: session.id, authorId: me.id, authorName: me.name });
  });

  it('moves a session and its context to another space, when the server can', async () => {
    fake.state.moveSession = true;
    try {
      const client = make();
      expect((await client.capabilities()).moveSession).toBe(true);
      const from = await client.createSpace({ name: `Move from ${kind}` });
      const to = await client.createSpace({ name: `Move to ${kind}` });
      const session = await client.createSession({ source: 'note', title: 'Filed in the wrong place', spaceId: from.id, text: 'x' });
      await client.saveFact({ sessionId: session.id, spaceId: from.id, statement: 'The Yarrowfield depot closes at six' });

      const moved = await client.moveSession(session.id, to.id);
      expect(moved).toMatchObject({ id: session.id, spaceId: to.id });
      expect((await client.listSessions({ spaceId: to.id })).map((s) => s.id)).toEqual([session.id]);
      expect(await client.listSessions({ spaceId: from.id })).toEqual([]);
      expect((await client.listContext(session.id)).map((c) => c.spaceId)).toEqual([to.id]);
      expect((await client.getSpace(to.id)).sessionCount).toBe(1);
    } finally {
      fake.state.moveSession = false;
    }
  });

  it('join by link: the owner makes a link, someone pastes it (or its code) and the space is theirs to use', async () => {
    fake.state.joinLinks = true;
    try {
      const owner = make();
      const joiner = kind === 'http' ? new HttpClient({ baseUrl: BASE, token: fake.tokens.b }) : owner;
      expect((await owner.capabilities()).joinLinks).toBe(true);
      const space = await owner.createSpace({ name: `Joinable ${kind}` });
      const link = await owner.createJoinLink(space.id, 'editor');
      expect(link.code).toMatch(/^[A-Za-z0-9_-]{4,}$/);
      expect(link.url).toContain(link.code);
      expect(link.role).toBe('editor');

      const joined = await joiner.joinSpace(`  ${link.url}  `);
      expect(joined).toMatchObject({ id: space.id, name: `Joinable ${kind}` });
      expect((await joiner.listSpaces()).map((s) => s.id)).toContain(space.id);
      if (kind === 'http') expect((await joiner.getSpace(space.id)).myRole).toBe('editor');

      const second = await owner.createJoinLink(space.id, 'reader');
      expect((await joiner.joinSpace(second.code)).id).toBe(space.id);
      await expect(joiner.joinSpace('nosuchcode123')).rejects.toMatchObject({ name: 'ApiError', kind: 'not-found' });
    } finally {
      fake.state.joinLinks = false;
    }
  });

  it('an unknown session rejects', async () => {
    await expect(make().getSession(kind === 'mock' ? 's-nope' : '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(Error);
  });

  it('says which areas are sample data — skills and pages are real on both', () => {
    const preview = make().preview;
    expect((preview as ReadonlySet<string>).has('skills')).toBe(false);
    expect(preview.has('pages')).toBe(false);
  });

  // ── skills ──────────────────────────────────────────────────────────────

  const SKILL = (name: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: Checks a draft. Use when someone shares one.\n---\n\n# Check a draft\n\n${body}\n`;

  it('new skill: v1 with a starter SKILL.md that is already valid, first in nobody’s way — listed, searchable, opened with files and history', async () => {
    const client = make();
    let notified = 0;
    client.subscribe(() => (notified += 1));
    const me = await client.getMe();
    const title = `Zebra crossing checklist ${kind}`;

    const created = await client.createSkill({ title });
    expect(created).toMatchObject({ title, currentVersion: 1, myRole: 'owner', runCount30d: 0, owner: { id: me.id, name: me.name } });
    expect(created.slug).toMatch(/^zebra-crossing-checklist/);
    expect(created.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(created.files[0]!.bytes).toBeGreaterThan(50);
    const fm = parseFrontmatter(created.files[0]!.content);
    expect(fm?.name).toBe(created.slug);
    expect(fm?.description).toBeTruthy();
    expect(created.versions).toEqual([expect.objectContaining({ version: 1, createdBy: { id: me.id, name: me.name } })]);
    expect(notified).toBeGreaterThanOrEqual(1);

    // No space given → the personal space.
    const personal = (await client.listSpaces()).find((s) => s.personal)!;
    expect(created.spaceId).toBe(personal.id);

    const listed = (await client.listSkills()).find((s) => s.id === created.id);
    expect(listed).toMatchObject({ title, slug: created.slug, description: fm!.description, currentVersion: 1, myRole: 'owner' });
    expect((await client.listSkills({ q: 'zebra crossing' })).map((s) => s.id)).toEqual([created.id]);
    expect(await client.listSkills({ q: 'no-such-skill-anywhere' })).toEqual([]);
    expect((await client.listSkills({ spaceId: personal.id })).map((s) => s.id)).toContain(created.id);

    expect(await client.getSkill(created.id)).toMatchObject({ id: created.id, title, files: created.files });
  });

  it('a skill can be created with its files, in a space', async () => {
    const client = make();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const skill = await client.createSkill({ title: 'Check a draft', spaceId: space.id, files: [{ path: 'SKILL.md', content: SKILL('check-a-draft') }, { path: 'references/tone.md', content: '# Tone\n' }] });
    expect(skill).toMatchObject({ spaceId: space.id, spaceName: space.name, description: 'Checks a draft. Use when someone shares one.' });
    expect(skill.files.map((f) => [f.path, f.bytes])).toEqual([
      ['SKILL.md', SKILL('check-a-draft').length],
      ['references/tone.md', 7],
    ]);
  });

  it('saving makes a new version with its note; old versions stay readable; a stale save is a version conflict', async () => {
    const client = make();
    const me = await client.getMe();
    const skill = await client.createSkill({ title: `Versioned ${kind}`, files: [{ path: 'SKILL.md', content: SKILL('versioned', 'First wording.') }] });

    const v2 = await client.saveSkill(skill.id, {
      baseVersion: 1,
      changeNote: 'second wording, plus examples',
      files: [{ path: 'SKILL.md', content: SKILL('versioned', 'Second wording.') }, { path: 'references/examples.md', content: '# Examples\n' }],
    });
    expect(v2.currentVersion).toBe(2);
    expect(v2.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/examples.md']);
    expect(v2.versions.map((v) => [v.version, v.changeNote, v.createdBy.name])).toEqual([
      [2, 'second wording, plus examples', me.name],
      [1, '', me.name],
    ]);
    expect((await client.listSkills()).find((s) => s.id === skill.id)?.currentVersion).toBe(2);

    const old = await client.getSkillVersion(skill.id, 1);
    expect(old.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(old[0]!.content).toContain('First wording.');
    await expect(client.getSkillVersion(skill.id, 9)).rejects.toMatchObject({ kind: 'not-found' });

    // Someone still on v1 tries to save.
    const stale = client.saveSkill(skill.id, { baseVersion: 1, files: [{ path: 'SKILL.md', content: SKILL('versioned', 'Late wording.') }] });
    await expect(stale).rejects.toMatchObject({ name: 'ApiError', kind: 'conflict', code: 'version_conflict', status: 409 });
    expect((await client.getSkill(skill.id)).currentVersion).toBe(2);
  });

  it('restoring an old version puts its files on top as a new version', async () => {
    const client = make();
    const skill = await client.createSkill({ title: `Restorable ${kind}`, files: [{ path: 'SKILL.md', content: SKILL('restorable', 'Original.') }] });
    await client.saveSkill(skill.id, { baseVersion: 1, files: [{ path: 'SKILL.md', content: SKILL('restorable', 'Worse.') }] });
    const restored = await client.restoreSkillVersion(skill.id, 1);
    expect(restored.currentVersion).toBe(3);
    expect(restored.files[0]!.content).toContain('Original.');
    expect(restored.versions[0]!.changeNote).toMatch(/v1/);
  });

  it.each([
    ['invalid_frontmatter', [{ path: 'SKILL.md', content: '# No block at the top\n' }]],
    ['invalid_frontmatter', [{ path: 'SKILL.md', content: '---\nname: only-a-name\n---\n' }]],
    ['missing_skill_md', [{ path: 'notes.md', content: 'x' }]],
    ['file_too_large', [{ path: 'SKILL.md', content: SKILL('big', 'x'.repeat(MAX_FILE_BYTES)) }]],
    ['too_many_files', [{ path: 'SKILL.md', content: SKILL('many') }, ...Array.from({ length: MAX_FILES }, (_, i) => ({ path: `references/${i}.md`, content: 'x' }))]],
    ['bad_path', [{ path: 'SKILL.md', content: SKILL('paths') }, { path: '../outside.md', content: 'x' }]],
    ['bad_path', [{ path: 'SKILL.md', content: SKILL('paths') }, { path: '/etc/passwd.txt', content: 'x' }]],
    ['bad_path', [{ path: 'SKILL.md', content: SKILL('paths') }, { path: 'logo.png', content: 'x' }]],
  ])('files that are not a skill are refused: %s', async (code, files) => {
    const client = make();
    await expect(client.createSkill({ title: 'Refused', files })).rejects.toMatchObject({ name: 'ApiError', kind: 'invalid', status: 422, code });
    const skill = await client.createSkill({ title: `Refusal target ${kind}` });
    await expect(client.saveSkill(skill.id, { baseVersion: 1, files })).rejects.toMatchObject({ kind: 'invalid', code });
    expect((await client.getSkill(skill.id)).currentVersion).toBe(1);
  });

  it('a skill can move to another space, be archived out of the list, and be deleted', async () => {
    const client = make();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const skill = await client.createSkill({ title: `Movable ${kind}` });
    expect(await client.updateSkill(skill.id, { spaceId: space.id })).toMatchObject({ id: skill.id, spaceId: space.id, spaceName: space.name });
    expect((await client.listSkills({ spaceId: space.id })).map((s) => s.id)).toContain(skill.id);

    await client.updateSkill(skill.id, { archived: true });
    expect((await client.listSkills()).some((s) => s.id === skill.id)).toBe(false);

    const other = await client.createSkill({ title: `Deletable ${kind}` });
    await client.deleteSkill(other.id);
    expect((await client.listSkills()).some((s) => s.id === other.id)).toBe(false);
    await expect(client.getSkill(other.id)).rejects.toMatchObject({ name: 'ApiError', kind: 'not-found' });
  });

  it('recording a run returns the files that ran and counts towards this month', async () => {
    const client = make();
    const skill = await client.createSkill({ title: `Runnable ${kind}` });
    const files = await client.recordSkillRun(skill.id);
    expect(files.map((f) => f.path)).toEqual(['SKILL.md']);
    await client.recordSkillRun(skill.id);
    expect((await client.getSkill(skill.id)).runCount30d).toBe(2);
  });

  it('a skill that does not exist is a typed not-found', async () => {
    const id = kind === 'mock' ? 'sk-nope' : '00000000-0000-4000-8000-000000000000';
    await expect(make().getSkill(id)).rejects.toMatchObject({ name: 'ApiError', kind: 'not-found' });
    await expect(make().recordSkillRun(id)).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('mock adapter — sample skills', () => {
  it('ships skills with real multi-section content, reference files, history, and every role', async () => {
    const client = new MockClient();
    const list = await client.listSkills();
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(new Set(list.map((s) => s.myRole))).toEqual(new Set(['owner', 'editor', 'reader']));
    for (const row of list) {
      const skill = await client.getSkill(row.id);
      const main = skill.files.find((f) => f.path === 'SKILL.md')!;
      expect(parseFrontmatter(main.content)).toMatchObject({ name: skill.slug, description: row.description });
      expect(main.content.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(skill.versions[0]!.version).toBe(skill.currentVersion);
      expect(skill.versions).toHaveLength(skill.currentVersion);
    }
    const marketing = await client.getSkill('sk-marketing');
    expect(marketing.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/voice.md', 'references/examples.md']);
    expect(marketing.versions.map((v) => [v.version, v.createdBy.name, v.changeNote])).toEqual([
      [4, 'Ana Reyes', 'shorter word limit'],
      [3, 'Ravi Menon', 'added the recall step'],
      [2, 'Ana Reyes', ''],
      [1, 'Ana Reyes', ''],
    ]);
    expect((await client.getSkillVersion('sk-marketing', 3))[0]!.content).toContain('under 90 words');
  });

  it('a reader cannot save or restore', async () => {
    const client = new MockClient();
    const skill = await client.getSkill('sk-followup');
    expect(skill.myRole).toBe('reader');
    await expect(client.saveSkill(skill.id, { baseVersion: skill.currentVersion, files: skill.files })).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(client.restoreSkillVersion(skill.id, 1)).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('http adapter — the edge', () => {
  it('sends the bearer token to /v1 and unwraps the envelope', async () => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('authorization')}`));
    await new HttpClient({ baseUrl: `${BASE}/`, token: fake.tokens.a }).getMe();
    server.events.removeAllListeners();
    expect(seen).toEqual([`GET /v1/me Bearer ${fake.tokens.a}`]);
  });

  it('401 → a typed unauthorized error, and the signed-out hook fires', async () => {
    let fired = 0;
    const client = new HttpClient({ baseUrl: BASE, token: 'okt_pat_wrong', onUnauthorized: () => (fired += 1) });
    const err = await client.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401, code: 'unauthorized', message: 'invalid or expired token' });
    expect(fired).toBe(1);
  });

  it('a server that is not there is a typed network error', async () => {
    const client = new HttpClient({ baseUrl: BASE, token: 'x', fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(client.getMe()).rejects.toMatchObject({ name: 'ApiError', kind: 'network' });
  });

  it('skills: a reader opens and runs but cannot save; an editor saves; a stranger gets not-found; only the owner shares', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const b = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    const c = new HttpClient({ baseUrl: BASE, token: fake.tokens.c });
    const skill = await a.createSkill({ title: 'Shared with Ana' });
    await expect(b.getSkill(skill.id)).rejects.toMatchObject({ kind: 'not-found' });

    await a.inviteByEmail({ type: 'skill', id: skill.id }, 'ana@openkt.test', 'reader');
    const asReader = await b.getSkill(skill.id);
    expect(asReader).toMatchObject({ myRole: 'reader', owner: { name: 'Pratham Bhatnagar' } });
    expect((await b.listSkills()).map((s) => [s.id, s.myRole])).toContainEqual([skill.id, 'reader']);
    expect((await b.recordSkillRun(skill.id)).map((f) => f.path)).toEqual(['SKILL.md']);
    await expect(b.saveSkill(skill.id, { baseVersion: 1, files: asReader.files })).rejects.toMatchObject({ kind: 'forbidden' });
    expect(await b.listGrants({ type: 'skill', id: skill.id })).toEqual([]);

    await a.inviteByEmail({ type: 'skill', id: skill.id }, 'ana@openkt.test', 'editor');
    const saved = await b.saveSkill(skill.id, { baseVersion: 1, changeNote: 'Ana’s pass', files: asReader.files });
    expect(saved.versions[0]).toMatchObject({ version: 2, changeNote: 'Ana’s pass', createdBy: { name: 'Ana Reyes' } });
    // The owner was still on v1: their save conflicts, and the latest version says who got there first.
    await expect(a.saveSkill(skill.id, { baseVersion: 1, files: asReader.files })).rejects.toMatchObject({ kind: 'conflict', code: 'version_conflict' });
    expect((await a.getSkill(skill.id)).versions[0]!.createdBy.name).toBe('Ana Reyes');

    await expect(c.getSkill(skill.id)).rejects.toMatchObject({ kind: 'not-found' });
    await expect(c.getSkillVersion(skill.id, 1)).rejects.toMatchObject({ kind: 'not-found' });
    expect((await c.listSkills()).some((s) => s.id === skill.id)).toBe(false);
  });

  it('a skill’s grant is removed by the person’s user id, a pending share by its own id — like every other grant', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const skill = await a.createSkill({ title: 'Grant ids' });
    const resource = { type: 'skill' as const, id: skill.id };
    const grant = await a.inviteByEmail(resource, 'ana@openkt.test', 'reader');
    const pending = await a.inviteByEmail(resource, 'later@elsewhere.test', 'reader');
    const ana = fake.users.find((u) => u.email === 'ana@openkt.test')!;
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => request.method === 'DELETE' && seen.push(new URL(request.url).pathname));
    await a.deleteGrant(resource, grant.subject);
    await a.deleteGrant(resource, pending.subject);
    server.events.removeAllListeners();
    expect(seen).toEqual([`/v1/skills/${skill.id}/grants/${ana.user_id}`, `/v1/skills/${skill.id}/grants/${pending.id}`]);
    expect((await a.listGrants(resource)).map((g) => g.role)).toEqual(['owner']);
  });

  it('sends the documented bodies for skills', async () => {
    const bodies: [string, string, unknown][] = [];
    server.events.on('request:start', async ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/v1/skills') && request.method !== 'GET') bodies.push([request.method, path.replace(/[0-9a-f-]{36}/, ':id'), await request.clone().json().catch(() => null)]);
    });
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const skill = await a.createSkill({ title: 'Wire shapes' });
    await a.saveSkill(skill.id, { baseVersion: 1, changeNote: ' tidy ', files: skill.files });
    await a.recordSkillRun(skill.id);
    await a.updateSkill(skill.id, { archived: true });
    server.events.removeAllListeners();
    expect(bodies).toEqual([
      ['POST', '/v1/skills', { title: 'Wire shapes' }],
      ['PUT', '/v1/skills/:id', { files: skill.files.map(({ path, content }) => ({ path, content })), change_note: 'tidy', base_version: 1 }],
      ['POST', '/v1/skills/:id/runs', { surface: 'app' }],
      ['PATCH', '/v1/skills/:id', { archived: true }],
    ]);
  });

  it('a server that has no skills endpoint yet answers a typed not-found, and the rest keeps working', async () => {
    server.use(http.get(`${BASE}/v1/skills`, () => HttpResponse.json({ data: null, error: { code: 'not_found', message: 'Cannot GET /v1/skills' }, meta: null }, { status: 404 })));
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    await expect(a.listSkills()).rejects.toMatchObject({ name: 'ApiError', kind: 'not-found', status: 404 });
    expect((await a.listSpaces()).length).toBeGreaterThan(0);
  });

  it('creating a space sends exactly {name, slug}; a 409 for that slug moves on to the next suffix', async () => {
    const bodies: unknown[] = [];
    let refused = 0;
    server.use(
      http.post(`${BASE}/v1/projects`, async ({ request }) => {
        const body = (await request.clone().json()) as { slug: string };
        bodies.push(body);
        if (body.slug === 'harbour-ops' && refused++ === 0) return HttpResponse.json({ data: null, error: { code: 'slug_taken', message: 'slug already taken' }, meta: null }, { status: 409 });
        return undefined; // fall through to the fake server
      }),
    );
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const space = await a.createSpace({ name: 'Harbour Ops', description: 'kept on this Mac' });
    expect(space.slug).toBe('harbour-ops-2');
    expect(bodies).toEqual([
      { name: 'Harbour Ops', slug: 'harbour-ops' },
      { name: 'Harbour Ops', slug: 'harbour-ops-2' },
    ]);
  });

  it('the server’s 400 “project slug already exists” is a taken slug too, and a slug this person can already see is never sent', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE}/v1/projects`, async ({ request }) => {
        const body = (await request.clone().json()) as { slug: string };
        seen.push(body.slug);
        if (body.slug === 'northgate-2') return HttpResponse.json({ data: null, error: { code: 'validation_error', message: 'project slug already exists' }, meta: null }, { status: 400 });
        return undefined;
      }),
    );
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    // "northgate" is already one of Pratham's spaces: it is skipped without asking.
    expect((await a.createSpace({ name: 'Northgate' })).slug).toBe('northgate-3');
    expect(seen).toEqual(['northgate-2', 'northgate-3']);
  });

  it('capabilities: routes production does not have read false (Nest’s “Cannot PATCH …”), and true once the server has them', async () => {
    expect(await new HttpClient({ baseUrl: BASE, token: fake.tokens.a }).capabilities()).toEqual({ moveSession: false, joinLinks: false });
    fake.state.moveSession = true;
    fake.state.joinLinks = true;
    try {
      expect(await new HttpClient({ baseUrl: BASE, token: fake.tokens.a }).capabilities()).toEqual({ moveSession: true, joinLinks: true });
    } finally {
      fake.state.moveSession = false;
      fake.state.joinLinks = false;
    }
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const space = (await a.listSpaces()).find((s) => !s.personal)!;
    const session = await a.createSession({ source: 'note', title: 'Stays put', spaceId: space.id });
    await expect(a.moveSession(session.id, space.id)).rejects.toMatchObject({ kind: 'not-found', status: 404, code: 'http_exception' });
    await expect(a.joinSpace('abcdef123')).rejects.toMatchObject({ kind: 'not-found', code: 'http_exception' });
  });

  it('a teammate: the shared space is in their list with their role, they save into it, and everyone sees who saved what', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const b = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    const space = await a.createSpace({ name: 'Kestrel rollout' });
    const kickoff = await a.createSession({ source: 'note', title: 'Kickoff', spaceId: space.id, text: 'x' });
    await a.saveFact({ sessionId: kickoff.id, spaceId: space.id, statement: 'Kestrel ships to the first ten stores in March', kind: 'decision' });
    await a.inviteByEmail({ type: 'space', id: space.id }, 'ana@openkt.test', 'editor');

    const listed = (await b.listSpaces()).find((s) => s.id === space.id);
    expect(listed).toMatchObject({ name: 'Kestrel rollout', personal: false, myRole: 'editor' });
    const note = await b.createSession({ source: 'voice', title: 'Store visit', spaceId: space.id, text: 'The Kestrel shelf labels need a bigger font' });
    await b.saveFact({ sessionId: note.id, spaceId: space.id, statement: 'Kestrel shelf labels need a bigger font', kind: 'issue' });

    // The owner: every session and fact says whose it is.
    const fresh = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    expect((await fresh.listSessions({ spaceId: space.id })).map((s) => [s.title, s.authorName])).toEqual([
      ['Store visit', 'Ana Reyes'],
      ['Kickoff', 'Pratham Bhatnagar'],
    ]);
    expect((await fresh.listSpaceContext(space.id)).map((c) => [c.statement, c.author])).toEqual([
      ['Kestrel shelf labels need a bigger font', 'Ana Reyes'],
      ['Kestrel ships to the first ten stores in March', 'Pratham Bhatnagar'],
    ]);
    expect((await fresh.getSession(note.id)).authorName).toBe('Ana Reyes');

    // The teammate may not list the grants: they see the owner, themselves, and who has saved things — and are told it is not everyone.
    const view = await new HttpClient({ baseUrl: BASE, token: fake.tokens.b }).listSpaceMembers(space.id);
    expect(view.complete).toBe(false);
    expect(view.members.map((m) => [m.name, m.role, Boolean(m.you)])).toEqual([
      ['Pratham Bhatnagar', 'owner', false],
      ['Ana Reyes', 'editor', true],
    ]);
  });

  it('search everything reaches a space someone shared with me, and each hit says who saved it and where', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const space = await a.createSpace({ name: 'Osprey pricing' });
    const s = await a.createSession({ source: 'note', title: 'Pricing', spaceId: space.id, text: 'x' });
    await a.saveFact({ sessionId: s.id, spaceId: space.id, statement: 'Osprey tiers are priced per warehouse', kind: 'decision' });
    await a.inviteByEmail({ type: 'space', id: space.id }, 'ana@openkt.test', 'reader');

    const b = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    const hits = await b.recall('osprey tiers warehouse');
    expect(hits.map((h) => [h.type, h.title, h.author, h.spaceName, h.kind, h.href])).toEqual([
      ['context', 'Osprey tiers are priced per warehouse', 'Pratham Bhatnagar', 'Osprey pricing', 'decision', `/sessions/${s.id}/context`],
    ]);
    // A session found by its title says whose it is and where, too.
    const byTitle = (await new HttpClient({ baseUrl: BASE, token: fake.tokens.b }).recall('pricing')).find((h) => h.type === 'session' && h.id === s.id);
    expect(byTitle).toMatchObject({ author: 'Pratham Bhatnagar', spaceName: 'Osprey pricing' });
  });

  it('a teammate sees a granted space’s context; a stranger gets not-found; neither can manage access', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const b = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    const c = new HttpClient({ baseUrl: BASE, token: fake.tokens.c });
    const space = (await a.listSpaces()).find((s) => !s.personal)!;
    const session = await a.createSession({ source: 'note', title: 'Invoices', spaceId: space.id, text: 'x' });
    await a.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Quillfeather invoices go to accounts payable' });
    const meB = await b.getMe();
    await a.putGrant({ type: 'space', id: space.id }, { type: 'user', id: meB.id, name: meB.name, initials: meB.initials }, 'reader');

    expect((await b.recall('quillfeather invoices', { spaceId: space.id })).map((h) => h.title)).toEqual(['Quillfeather invoices go to accounts payable']);
    await expect(c.recall('quillfeather invoices', { spaceId: space.id })).rejects.toMatchObject({ kind: 'not-found' });
    await expect(c.getSession(session.id)).rejects.toMatchObject({ kind: 'not-found' });
    expect(await b.listGrants({ type: 'space', id: space.id })).toEqual([]);
  });
});
