import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeServer } from '../../../test/support/fake-server';
import type { OpenKTClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { ApiProvider } from '../../api/hooks';
import { HttpClient } from '../../api/http';
import { MockClient } from '../../api/mock';
import { describeSkillErrorCode } from '../../api/skillFiles';
import { AppRoutes } from '../../app/AppRoutes';
import { skillDrafts } from './drafts';

function renderApp(route: string, client: OpenKTClient = new MockClient()) {
  render(
    <ApiProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </ApiProvider>,
  );
  return client;
}

const editorFor = (path = 'SKILL.md') => screen.findByRole('textbox', { name: `Edit ${path}` });
const setText = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

afterEach(() => {
  skillDrafts.clear();
  delete (window as { openkt?: unknown }).openkt;
});

describe('skills library', () => {
  it('every card opens its skill; search filters; Run is its own button', async () => {
    const user = userEvent.setup();
    renderApp('/skills');
    const list = await screen.findByRole('list', { name: 'Skills' });
    // Five written by hand, six drawn from the sample teams' pages.
    expect(within(list).getAllByRole('listitem')).toHaveLength(11);
    expect(within(list).getByText('v4 · used 31 times this month')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Run a sales discovery call' })).toBeInTheDocument();
    expect(screen.queryByText('Preview — sample data')).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search skills' }), 'bug report');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('1 of 11');
    await user.click(within(list).getByRole('button', { name: 'Run Triage a bug report' }));
    expect(await screen.findByRole('dialog', { name: 'Run “Triage a bug report”' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await user.click(within(list).getByRole('link', { name: 'Triage a bug report' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Triage a bug report' })).toBeInTheDocument();
  });

  it('a server that has no skills yet says so plainly, and the rest of the app keeps working', async () => {
    const BASE = 'http://openkt.test';
    const fake = createFakeServer(BASE);
    const server = setupServer(...fake.handlers);
    server.listen({ onUnhandledRequest: 'bypass' });
    // What production answers today: the route does not exist.
    server.use(http.get(`${BASE}/v1/skills`, () => HttpResponse.json({ data: null, error: { code: 'not_found', message: 'Cannot GET /v1/skills' }, meta: null }, { status: 404 })));
    try {
      const user = userEvent.setup();
      renderApp('/skills', new HttpClient({ baseUrl: BASE, token: fake.tokens.a }));
      expect(await screen.findByText('Skills aren’t available on this server yet')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /New skill/ })).toBeDisabled();
      expect(screen.queryByText('Preview — sample data')).not.toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Skills' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('link', { name: 'Spaces' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/spaces/'))).toBe(true));
    } finally {
      server.close();
    }
  });
});

describe('a skill, opened', () => {
  it('shows its real content: frontmatter as a quiet header, rendered markdown, reference files, the raw source', async () => {
    const user = userEvent.setup();
    renderApp('/skills/sk-marketing');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sharpen a marketing message' })).toBeInTheDocument();
    expect(screen.getByText('v4 · edited by Ana 2 days ago')).toBeInTheDocument();
    expect(await screen.findByText('marketing can edit · sales can use')).toBeInTheDocument();

    const read = screen.getByTestId('skill-read');
    expect(within(read).getByText('name')).toBeInTheDocument();
    expect(within(read).getByText('sharpen-marketing-message')).toBeInTheDocument();
    expect(within(read).getByText(/^Rewrite a marketing draft in our voice\./)).toBeInTheDocument();
    expect(within(read).getByRole('heading', { name: 'Voice' })).toBeInTheDocument();
    expect(within(read).getByText('Short sentences. One claim per message.')).toBeInTheDocument();
    expect(within(read).queryByText(/^---/)).not.toBeInTheDocument();

    // A link to another file of the skill opens it.
    await user.click(within(read).getByRole('link', { name: 'references/voice.md' }));
    const voice = screen.getByTestId('skill-read');
    expect(within(voice).getByRole('heading', { name: 'Our voice' })).toBeInTheDocument();
    expect(within(voice).getByRole('cell', { name: '120 words, one link' })).toBeInTheDocument();

    // The rail switches files too.
    const files = screen.getByRole('region', { name: 'Files' });
    await user.click(within(files).getByRole('button', { name: /references\/examples\.md/ }));
    expect(within(screen.getByTestId('skill-read')).getByRole('heading', { name: 'Before and after' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Source of references/examples.md' });
    expect(source).toHaveAttribute('readonly');
    expect((source as HTMLTextAreaElement).value.startsWith('# Before and after')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toContain('Northgate reorders in ten minutes');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('a reader sees no Edit or Share, is told whom to ask, and cannot reach the editor', async () => {
    renderApp('/skills/sk-followup');
    expect(await screen.findByRole('heading', { level: 1, name: 'Follow-up after a customer call' })).toBeInTheDocument();
    expect(screen.getByText('You can use this skill. Ask Ana for edit access.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    cleanup();

    renderApp('/skills/sk-followup/edit');
    expect(await screen.findByRole('heading', { level: 1, name: 'Follow-up after a customer call' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a skill that isn’t there (or isn’t shared) says so', async () => {
    renderApp('/skills/sk-nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'This skill isn’t here' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to skills' })).toBeInTheDocument();
  });

  it('an old version opens read-only; an editor restores it as a new version', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing');
    await user.click(await screen.findByRole('link', { name: /^v3 — Ravi/ }));
    const bar = await screen.findByRole('region', { name: 'Viewing v3' });
    expect(bar).toHaveTextContent('Ravi · 3 weeks ago · added the recall step');
    expect(await screen.findByText('Rewrite. Keep it under 90 words unless asked otherwise.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'Restore this version' }));
    expect(await screen.findByText('Restored v3 as v5.')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('region', { name: 'Viewing v3' })).not.toBeInTheDocument();
    const skill = await client.getSkill('sk-marketing');
    expect(skill.currentVersion).toBe(5);
    expect(skill.files[0]!.content).toContain('under 90 words');
    expect(screen.getByRole('link', { name: /^v5 \(current\) — you · today · restored v3/ })).toBeInTheDocument();
  });

  it('a reader viewing an old version gets no Restore', async () => {
    renderApp('/skills/sk-followup/versions/1');
    expect(await screen.findByRole('region', { name: 'Viewing v1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument();
  });

  it('share by email: only the owner can share; someone without an account shows as pending', async () => {
    const user = userEvent.setup();
    renderApp('/skills/sk-marketing');
    await screen.findByRole('heading', { level: 1, name: 'Sharpen a marketing message' });
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument(); // an editor, not the owner
    cleanup();

    const client = renderApp('/skills/sk-pr');
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “Write a pull request description”' });
    expect(within(sheet).getByText('Who can use this skill')).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText('Invite by email'), 'dana@partner.test{Enter}');
    const row = (await within(sheet).findByText('dana@partner.test')).closest('li')!;
    expect(within(row).getByText('Invited — hasn’t joined yet')).toBeInTheDocument();
    expect(within(sheet).getByRole('status')).toHaveTextContent('dana@partner.test isn’t on OpenKT yet. They’ll get access to this skill as soon as they join.');
    const grants = await client.listGrants({ type: 'skill', id: 'sk-pr' });
    expect(grants.find((g) => g.subject.email === 'dana@partner.test')).toMatchObject({ pending: true, role: 'reader' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Who can use it' })).getByText('invited · reader')).toBeInTheDocument();
  });
});

describe('editing a skill', () => {
  it('an editor edits, saves with a note, and the new version is current and in the rail', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const editor = await editorFor();
    expect(screen.getByText('editing · your changes become v5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument(); // never SKILL.md
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    const text = (editor as HTMLTextAreaElement).value.replace('Keep it under 60 words', 'Keep it under 50 words');
    setText(editor, text);
    expect(within(screen.getByRole('region', { name: 'Files' })).getByRole('button', { name: /SKILL\.md/ })).toHaveTextContent('edited');
    await user.type(screen.getByLabelText('What changed'), 'even shorter');
    await user.click(screen.getByRole('button', { name: 'Save as v5' }));

    expect(await screen.findByText('Saved as v5.')).toHaveAttribute('role', 'status');
    expect(screen.getByText('v5 · edited by you today')).toBeInTheDocument();
    expect(screen.getByText('Rewrite. Keep it under 50 words unless asked otherwise.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^v5 \(current\) — you · today · even shorter/ })).toBeInTheDocument();
    const saved = await client.getSkill('sk-marketing');
    expect(saved).toMatchObject({ currentVersion: 5, versions: [expect.objectContaining({ version: 5, changeNote: 'even shorter' }), ...saved.versions.slice(1)] });
    expect(saved.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/voice.md', 'references/examples.md']);
  });

  it('⌘S saves, Tab indents, Esc on an untouched editor goes back to reading', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-triage/edit');
    const editor = (await editorFor()) as HTMLTextAreaElement;
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const again = (await editorFor()) as HTMLTextAreaElement;
    expect(again).not.toBe(editor);
    again.setSelectionRange(again.value.length, again.value.length);
    await user.click(again);
    again.setSelectionRange(again.value.length, again.value.length);
    await user.keyboard('{Tab}x');
    expect(again.value.endsWith('\n  x')).toBe(true);
    await user.keyboard('{Control>}s{/Control}');
    expect(await screen.findByText('Saved as v4.')).toHaveAttribute('role', 'status');
    expect((await client.getSkill('sk-triage')).files[0]!.content.endsWith('\n  x')).toBe(true);
  });

  it('checks the frontmatter as you type, never sends a broken skill, and can put the block back', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing/edit');
    const editor = (await editorFor()) as HTMLTextAreaElement;

    setText(editor, '# Sharpen a marketing message\n\nRewrite the draft.\n');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('In SKILL.md: The first lines need a name and a description, like this:');
    expect(alert).toHaveTextContent('name: sharpen-marketing-message');
    await user.click(screen.getByRole('button', { name: 'Save as v5' }));
    expect(screen.getByRole('textbox', { name: 'Edit SKILL.md' })).toBeInTheDocument();
    expect((await client.getSkill('sk-marketing')).currentVersion).toBe(4);

    await user.click(within(alert).getByRole('button', { name: 'Add it at the top' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(editor.value.startsWith('---\nname: sharpen-marketing-message\ndescription: Rewrite a marketing draft')).toBe(true);

    setText(editor, '---\nname: sharpen-marketing-message\n---\n\n# Sharpen\n');
    expect(await screen.findByRole('alert')).toHaveTextContent('missing its description');
    setText(editor, '---\nname: Sharpen It\ndescription: Does it.\n---\n');
    expect(await screen.findByRole('alert')).toHaveTextContent('The name can only use lowercase letters, numbers and hyphens');
  });

  it('turns the server’s refusal codes into sentences', async () => {
    class Refusing extends MockClient {
      override async saveSkill(): Promise<never> {
        throw new ApiError('invalid', 'file too large', 422, 'file_too_large', '/skills/sk-marketing');
      }
    }
    const user = userEvent.setup();
    renderApp('/skills/sk-marketing/edit', new Refusing());
    const editor = (await editorFor()) as HTMLTextAreaElement;
    setText(editor, `${editor.value}\nMore.\n`);
    await user.click(screen.getByRole('button', { name: 'Save as v5' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(describeSkillErrorCode('file_too_large'));
    expect(screen.getByRole('textbox', { name: 'Edit SKILL.md' })).toBeInTheDocument();
  });

  it('files: add (with the path checked), rename, delete — and the save carries all of it', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing/edit');
    await editorFor();
    const rail = screen.getByRole('region', { name: 'Files' });

    await user.click(within(rail).getByRole('button', { name: 'Add a file' }));
    const path = within(rail).getByLabelText('New file path');
    expect(path).toHaveValue('references/');
    await user.clear(path);
    await user.type(path, '../secrets.md{Enter}');
    expect(within(rail).getByRole('alert')).toHaveTextContent('A path can’t use “..” — files stay inside the skill.');
    await user.clear(path);
    await user.type(path, 'references/logo.png{Enter}');
    expect(within(rail).getByRole('alert')).toHaveTextContent('Skills hold text files.');
    await user.clear(path);
    await user.type(path, 'references/faq.md{Enter}');
    const faq = (await editorFor('references/faq.md')) as HTMLTextAreaElement;
    expect(faq.value).toBe('# Faq\n\n');
    expect(within(rail).getByRole('button', { name: /references\/faq\.md/ })).toHaveTextContent('new');

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const rename = screen.getByLabelText('New path for references/faq.md');
    await user.clear(rename);
    await user.type(rename, 'references/voice.md{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('There is already a file with that name.');
    await user.clear(rename);
    await user.type(rename, 'references/questions.md{Enter}');
    expect(await editorFor('references/questions.md')).toBeInTheDocument();

    await user.click(within(rail).getByRole('button', { name: /references\/examples\.md/ }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const ask = screen.getByRole('alertdialog', { name: 'Delete references/examples.md?' });
    await user.click(within(ask).getByRole('button', { name: 'Delete file' }));
    expect(within(rail).queryByRole('button', { name: /references\/examples\.md/ })).not.toBeInTheDocument();
    expect(within(rail).getByText('1 file removed when you save')).toBeInTheDocument();
    expect(await editorFor('SKILL.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save as v5' }));
    expect(await screen.findByText('Saved as v5.')).toHaveAttribute('role', 'status');
    expect((await client.getSkill('sk-marketing')).files.map((f) => f.path)).toEqual(['SKILL.md', 'references/voice.md', 'references/questions.md']);
  });

  it('409: when a teammate saved first, “Keep editing” copies mine and saves on top of theirs', async () => {
    const user = userEvent.setup();
    const client = new MockClient();
    renderApp('/skills/sk-marketing/edit', client);
    const editor = (await editorFor()) as HTMLTextAreaElement;
    const mine = editor.value.replace('Say who it is for in the first line.', 'Say who it is for in the first five words.');
    setText(editor, mine);

    client.simulateTeammateSave('sk-marketing', 'u-ana', 'tightened the voice', (files) => files.map((f) => (f.path === 'SKILL.md' ? { ...f, content: f.content.replace('Plain words.', 'Plain, short words.') } : f)));
    await user.click(screen.getByRole('button', { name: 'Save as v5' }));

    const ask = await screen.findByRole('alertdialog', { name: 'Ana saved a newer version while you were editing' });
    expect(ask).toHaveTextContent('v5 — “tightened the voice”');
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(await navigator.clipboard.readText()).toBe(mine);
    expect(screen.getByText(/Your version is on the clipboard\. Saving now makes v6/)).toBeInTheDocument();
    expect(screen.getByText('editing · your changes become v6')).toBeInTheDocument();
    expect(editor.value).toBe(mine);

    await user.click(screen.getByRole('button', { name: 'Save as v6' }));
    expect(await screen.findByText('Saved as v6.')).toHaveAttribute('role', 'status');
    const skill = await client.getSkill('sk-marketing');
    expect(skill.currentVersion).toBe(6);
    expect(skill.files[0]!.content).toBe(mine);
    expect(skill.versions.slice(0, 2).map((v) => [v.version, v.createdBy.name])).toEqual([
      [6, 'Pratham Bhatnagar'],
      [5, 'Ana Reyes'],
    ]);
  });

  it('409: “View theirs” shows the newer version and keeps my edits to come back to', async () => {
    const user = userEvent.setup();
    const client = new MockClient();
    renderApp('/skills/sk-marketing/edit', client);
    const editor = (await editorFor()) as HTMLTextAreaElement;
    const mine = `${editor.value}\nOne more rule of mine.\n`;
    setText(editor, mine);
    client.simulateTeammateSave('sk-marketing', 'u-ana', 'tightened the voice', (files) => files);
    await user.click(screen.getByRole('button', { name: 'Save as v5' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'View theirs' }));

    expect(await screen.findByText('v5 · edited by Ana today')).toBeInTheDocument();
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('You have unsaved changes to this skill, started from v4.');
    await user.click(within(bar).getByRole('button', { name: 'Continue editing' }));
    expect(((await editorFor()) as HTMLTextAreaElement).value).toBe(mine);
    expect(screen.getByRole('status')).toHaveTextContent('Picked up your unsaved changes, started from v4.');
  });

  it('leaving by a link with unsaved changes asks first; any other way out keeps the draft', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing/edit');
    const editor = (await editorFor()) as HTMLTextAreaElement;
    setText(editor, `${editor.value}\nA new line.\n`);

    await user.click(screen.getByRole('link', { name: 'Spaces' }));
    const ask = screen.getByRole('alertdialog', { name: 'Discard your changes?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: 'Edit SKILL.md' })).toHaveValue(`${editor.value}`);
    expect(editor.value).toContain('A new line.');

    // Unmounting the editor any other way (here: the whole app) keeps what was typed.
    cleanup();
    renderApp('/skills/sk-marketing', client);
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    await user.click(within(bar).getByRole('button', { name: 'Continue editing' }));
    expect(((await editorFor()) as HTMLTextAreaElement).value).toContain('A new line.');

    await user.click(screen.getByRole('link', { name: 'Spaces' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
    expect(skillDrafts.get('sk-marketing')).toBeUndefined();
    expect((await client.getSkill('sk-marketing')).currentVersion).toBe(4);
  });

  it('new skill: a name and a space, then straight into writing it', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills');
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    const dialog = screen.getByRole('dialog', { name: 'New skill' });
    await user.click(within(dialog).getByRole('button', { name: 'Create and write' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give it a name');

    await user.type(within(dialog).getByLabelText('Name'), 'Answer a pricing question');
    await user.click(within(dialog).getByRole('button', { name: 'Space: personal — only you' }));
    await user.click(await within(dialog).findByRole('option', { name: 'sales' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create and write' }));

    const editor = (await editorFor()) as HTMLTextAreaElement;
    expect(editor.value).toMatch(/^---\nname: answer-a-pricing-question\ndescription: .+\n---\n\n# Answer a pricing question\n/);
    expect(screen.getByRole('heading', { level: 1, name: 'Answer a pricing question' })).toBeInTheDocument();
    expect(screen.getByText('editing · your changes become v2')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('sales');
    const listed = (await client.listSkills()).find((s) => s.title === 'Answer a pricing question');
    expect(listed).toMatchObject({ spaceId: 'sp-sales', currentVersion: 1, myRole: 'owner' });
  });
});

describe('running a skill', () => {
  it('without a local chat model: says so plainly, hands over the skill, records nothing', async () => {
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const sheet = await screen.findByRole('dialog', { name: 'Run “Sharpen a marketing message”' });
    expect(within(sheet).getByText('Rewrite the draft so it sounds like us.')).toBeInTheDocument();
    expect(within(sheet).getByText('v4 · Voice · Steps · Output · + 2 reference files')).toBeInTheDocument();
    expect(within(sheet).getByRole('status')).toHaveTextContent('Running skills on this Mac arrives with the next build — for now, use this skill from any connected AI tool: it is available there as sharpen-marketing-message.');
    expect(within(sheet).queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();

    await user.type(within(sheet).getByLabelText('Your input'), 'We are thrilled to announce');
    await user.click(within(sheet).getByRole('button', { name: 'Copy skill with your input' }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('name: sharpen-marketing-message');
    expect(copied).toContain('File: references/voice.md');
    expect(copied).toContain('Input:\n\nWe are thrilled to announce');
    expect((await client.getSkill('sk-marketing')).runCount30d).toBe(31);
  });

  it('with a local chat model: runs the skill on the input, shows the result, and records one run', async () => {
    const chat = vi.fn(async (_input: { system: string; user: string }) => ({ text: 'For store managers: see what is out of place in under a minute.' }));
    (window as { openkt?: unknown }).openkt = {
      platform: 'browser',
      app: { onNavigate: () => () => undefined, hotkeys: async () => [], openMain: async () => undefined },
      capture: { onEvent: () => () => undefined },
      localAi: { chat },
    };
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const sheet = await screen.findByRole('dialog', { name: 'Run “Sharpen a marketing message”' });
    const run = within(sheet).getByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Your input'), 'Our revolutionary engine!');
    await user.click(run);

    expect(await within(sheet).findByText('For store managers: see what is out of place in under a minute.')).toBeInTheDocument();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0].user).toBe('Our revolutionary engine!');
    expect(chat.mock.calls[0]![0].system).toContain('# Sharpen a marketing message');
    expect(chat.mock.calls[0]![0].system).toContain('File: references/examples.md');
    await waitFor(async () => expect((await client.getSkill('sk-marketing')).runCount30d).toBe(32));
  });

  it('a failed local run is shown and not recorded', async () => {
    (window as { openkt?: unknown }).openkt = {
      platform: 'browser',
      app: { onNavigate: () => () => undefined, hotkeys: async () => [], openMain: async () => undefined },
      capture: { onEvent: () => () => undefined },
      localAi: { chat: async () => ({ text: '' }) },
    };
    const user = userEvent.setup();
    const client = renderApp('/skills/sk-marketing');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const sheet = await screen.findByRole('dialog');
    await user.type(within(sheet).getByLabelText('Your input'), 'Draft');
    await user.click(within(sheet).getByRole('button', { name: 'Run' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The model on this Mac couldn’t run it: The local model returned nothing.');
    expect((await client.getSkill('sk-marketing')).runCount30d).toBe(31);
  });
});
