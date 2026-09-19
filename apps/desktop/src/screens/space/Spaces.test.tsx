/**
 * Teams, on screen: making a space (and the slug that gets a suffix when it is
 * taken), sharing it on the way in, the space every save starts on, who saved
 * what, and the join-by-link controls that stay hidden on a server without
 * them. The http cases run the real adapter against the fake server
 * (test/support/fake-server.ts), whose defaults answer like production does
 * today.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServer } from '../../../test/support/fake-server';
import type { OpenKTClient } from '../../api/client';
import { ApiProvider } from '../../api/hooks';
import { HttpClient } from '../../api/http';
import { MockClient } from '../../api/mock';
import { AppRoutes } from '../../app/AppRoutes';

const BASE = 'http://openkt.test';
const fake = createFakeServer(BASE);
const server = setupServer(...fake.handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => localStorage.clear());
afterEach(() => {
  server.resetHandlers();
  fake.state.joinLinks = false;
  fake.state.moveSession = false;
});
afterAll(() => server.close());

const as = (who: 'a' | 'b') => new HttpClient({ baseUrl: BASE, token: fake.tokens[who] });

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

const main = () => screen.getByRole('main');
/** Each person row as [name, the mono line under it]. */
const rowsOf = (list: HTMLElement) => within(list).getAllByRole('listitem').map((li) => [li.querySelector('.member__name')?.textContent, li.querySelector('.member__sub')?.textContent ?? '']);

describe('new space', () => {
  it('a taken slug gets the next suffix; the shares go out; it opens on its page with its people', async () => {
    const user = userEvent.setup();
    const sent: string[] = [];
    server.use(
      http.post(`${BASE}/v1/projects`, async ({ request }) => {
        const { slug } = (await request.clone().json()) as { slug: string };
        sent.push(slug);
        // Someone else's space already has this slug.
        if (slug === 'launch-plan') return HttpResponse.json({ data: null, error: { code: 'slug_taken', message: 'slug already taken' }, meta: null }, { status: 409 });
        return undefined;
      }),
    );
    renderApp('/spaces', as('a'));
    await user.click(await within(main()).findByRole('button', { name: 'New space' }));
    const dialog = await screen.findByRole('dialog', { name: 'New space' });
    await user.type(within(dialog).getByLabelText('Name'), 'Launch plan');
    expect(within(dialog).getByText('launch-plan')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/What goes in it/), 'Decisions for the Q4 launch');
    await user.click(within(dialog).getByRole('radio', { name: /Share with people/ }));
    await user.type(within(dialog).getByLabelText('Emails'), 'ana@openkt.test, dana@newco.test');
    await user.click(within(dialog).getByRole('button', { name: 'Create space' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Launch plan' })).toBeInTheDocument();
    expect(sent).toEqual(['launch-plan', 'launch-plan-2']);
    expect(fake.projects.find((p) => p['name'] === 'Launch plan')).toMatchObject({ slug: 'launch-plan-2' });
    expect(screen.getByText('Decisions for the Q4 launch')).toBeInTheDocument();

    const people = await screen.findByRole('list', { name: 'People in this space' });
    await waitFor(() => expect(within(people).getAllByRole('listitem')).toHaveLength(3));
    expect(rowsOf(people)).toEqual([
      ['Pratham Bhatnagar', 'owner · you'],
      ['Ana Reyes', 'editor'],
      ['dana@newco.test', 'invited · hasn’t joined yet'],
    ]);
  });

  it('a bad email is caught before anything is created', async () => {
    const user = userEvent.setup();
    const client = renderApp('/spaces') as MockClient;
    const before = (await client.listSpaces()).length;
    await user.click(await within(main()).findByRole('button', { name: 'New space' }));
    const dialog = await screen.findByRole('dialog', { name: 'New space' });
    await user.type(within(dialog).getByLabelText('Name'), 'Partners');
    await user.click(within(dialog).getByRole('radio', { name: /Share with people/ }));
    await user.type(within(dialog).getByLabelText('Emails'), 'ana@example.com, dana@');
    await user.click(within(dialog).getByRole('button', { name: 'Create space' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('dana@ isn’t a full email address. Use name@company.com.');
    expect(await client.listSpaces()).toHaveLength(before);
  });

  it('the + beside Spaces in the sidebar makes a private space and opens it', async () => {
    const user = userEvent.setup();
    const client = renderApp('/sessions/s-northgate-pricing') as MockClient;
    await user.click(await screen.findByRole('button', { name: 'New space' }));
    const dialog = await screen.findByRole('dialog', { name: 'New space' });
    expect(within(dialog).getByRole('radio', { name: /Just me/ })).toBeChecked();
    await user.type(within(dialog).getByLabelText('Name'), 'Reading list');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Reading list' })).toBeInTheDocument();
    const made = (await client.listSpaces()).find((s) => s.name === 'Reading list');
    expect(made).toMatchObject({ slug: 'reading-list', memberCount: 1, myRole: 'owner' });
    expect(within(await screen.findByRole('list', { name: 'People in this space' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Invite your team' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing saved here yet/)).toBeInTheDocument();
  });
});

describe('the space a save goes into', () => {
  it('Personal at first, then the space saved into last; a space page’s “New note here” picks its own', async () => {
    const user = userEvent.setup();
    const client = new MockClient();
    const saveTo = () => screen.getByRole('button', { name: /^Save to space:/ });

    renderApp('/new', client);
    await waitFor(() => expect(saveTo()).toHaveTextContent('Personal'));
    await user.click(saveTo());
    await user.click(screen.getByRole('option', { name: /^engineering \/ openkt/ }));
    await user.type(screen.getByLabelText('Note', { exact: true }), 'The staging database moves to the new cluster on Monday.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('tab', { name: 'Summary' });
    const [saved] = await client.listSessions({ spaceId: 'sp-openkt' });
    expect(saved).toMatchObject({ source: 'note', title: 'The staging database moves to the new cluster on Monday.' });
    cleanup();

    renderApp('/new', client);
    await waitFor(() => expect(saveTo()).toHaveTextContent('engineering / openkt'));
    cleanup();

    renderApp('/spaces/sp-northgate', client);
    await userEvent.setup().click(await screen.findByRole('link', { name: 'New note here' }));
    await waitFor(() => expect(saveTo()).toHaveTextContent('sales / northgate'));
  });
});

describe('who saved what', () => {
  it('the owner’s space page names the teammate on their session and their facts; the teammate sees the owner and their own role', async () => {
    const a = as('a');
    const b = as('b');
    const space = await a.createSpace({ name: 'Kestrel rollout' });
    const kickoff = await a.createSession({ source: 'note', title: 'Kickoff', spaceId: space.id, text: 'x' });
    await a.saveFact({ sessionId: kickoff.id, spaceId: space.id, statement: 'Kestrel ships to ten stores in March', kind: 'decision' });
    await a.inviteByEmail({ type: 'space', id: space.id }, 'ana@openkt.test', 'editor');
    const visit = await b.createSession({ source: 'voice', title: 'Store visit', spaceId: space.id, text: 'Bigger labels' });
    await b.saveFact({ sessionId: visit.id, spaceId: space.id, statement: 'Kestrel shelf labels need a bigger font', kind: 'issue' });

    renderApp(`/spaces/${space.id}`, as('a'));
    const context = await screen.findByRole('list', { name: 'Context in this space' });
    await waitFor(() => expect(within(context).getAllByRole('listitem')).toHaveLength(2));
    expect(within(context).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['issueKestrel shelf labels need a bigger fontAna Reyes · Store visit · today', `/sessions/${visit.id}/context`],
      ['decisionKestrel ships to ten stores in MarchPratham Bhatnagar · Kickoff · today', `/sessions/${kickoff.id}/context`],
    ]);
    expect(within(main()).getByRole('link', { name: /^Store visit/ })).toHaveTextContent('Ana · today');
    expect(within(main()).getByRole('link', { name: /^Kickoff/ })).toHaveTextContent('Pratham · today');
    cleanup();

    renderApp(`/spaces/${space.id}`, as('b'));
    expect(await screen.findByText(/shared with you · editor/)).toBeInTheDocument();
    const people = await screen.findByRole('list', { name: 'People in this space' });
    await waitFor(() =>
      expect(rowsOf(people)).toEqual([
        ['Pratham Bhatnagar', 'owner'],
        ['Ana Reyes', 'editor · you'],
      ]),
    );
    expect(screen.getByText('only the owner sees everyone with access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Access' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New note here' })).toBeInTheDocument();
  });

  it('⌘K over everything finds a fact in a space someone shared, and says who saved it and where', async () => {
    const a = as('a');
    const space = await a.createSpace({ name: 'Osprey pricing' });
    const s = await a.createSession({ source: 'note', title: 'Pricing', spaceId: space.id, text: 'x' });
    await a.saveFact({ sessionId: s.id, spaceId: space.id, statement: 'Osprey tiers are priced per warehouse', kind: 'decision' });
    await a.inviteByEmail({ type: 'space', id: space.id }, 'ana@openkt.test', 'reader');

    const user = userEvent.setup();
    renderApp('/spaces', as('b'));
    await screen.findByRole('heading', { level: 1, name: 'Spaces' });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'osprey warehouse');
    const hit = await screen.findByRole('option', { name: /Osprey tiers are priced per warehouse/ });
    expect(hit).toHaveTextContent('decision · Pratham Bhatnagar · Osprey pricing');
  });
});

describe('join by link', () => {
  it('hidden while the server has no join endpoints (production today); Invite by email still works', async () => {
    const a = as('a');
    const space = await a.createSpace({ name: 'No links yet' });
    renderApp('/spaces', a);
    await within(main()).findByRole('button', { name: 'New space' });
    await act(() => a.capabilities());
    expect(screen.queryByRole('button', { name: 'Join a team' })).not.toBeInTheDocument();
    cleanup();

    renderApp(`/spaces/${space.id}`, a);
    expect(await screen.findByRole('button', { name: 'Invite' })).toBeInTheDocument();
    await act(() => a.capabilities());
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
  });

  it('with the endpoints: the owner copies a link, a teammate pastes it and lands in the space', async () => {
    fake.state.joinLinks = true;
    const user = userEvent.setup(); // (installs its own clipboard; ours goes on top)
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const a = as('a');
      const space = await a.createSpace({ name: 'Heron team' });
      renderApp(`/spaces/${space.id}`, a);
      await user.click(await screen.findByRole('button', { name: 'Copy invite link' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Invite link copied. Anyone who has it can join this space as an editor.');
      const url = writeText.mock.calls[0]![0];
      expect(url).toMatch(/^https:\/\/api\.openkt\.ai\/join\/[a-z0-9]{10}$/);
      cleanup();

      renderApp('/spaces', as('b'));
      await user.click(await screen.findByRole('button', { name: 'Join a team' }));
      const dialog = await screen.findByRole('dialog', { name: 'Join a team' });
      await user.type(within(dialog).getByLabelText('Invite link or code'), url);
      await user.click(within(dialog).getByRole('button', { name: 'Join' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Heron team' })).toBeInTheDocument();
      expect(await screen.findByText(/shared with you · editor/)).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    }
  });

  it('a link that is not valid says so', async () => {
    fake.state.joinLinks = true;
    const user = userEvent.setup();
    renderApp('/spaces', as('b'));
    await user.click(await screen.findByRole('button', { name: 'Join a team' }));
    const dialog = await screen.findByRole('dialog', { name: 'Join a team' });
    await user.type(within(dialog).getByLabelText('Invite link or code'), 'https://api.openkt.ai/join/Expired123');
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That invite link isn’t valid any more. Ask for a new one.');
  });
});

describe('moving a session', () => {
  it('offered when the server can, and the session lands in the other space', async () => {
    const user = userEvent.setup();
    const client = renderApp('/sessions/s-northgate-pricing') as MockClient;
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to another space…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to another space' });
    await user.click(within(dialog).getByRole('button', { name: /^Move to:/ }));
    await user.click(within(dialog).getByRole('option', { name: /^ideas/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await client.getSession('s-northgate-pricing')).spaceId).toBe('sp-ideas');
    expect(await screen.findByRole('link', { name: 'ideas' })).toHaveAttribute('href', '/spaces/sp-ideas');
  });

  it('not offered on a server without PATCH /v1/sessions/:id', async () => {
    const user = userEvent.setup();
    const a = as('a');
    const space = (await a.listSpaces()).find((s) => !s.personal)!;
    const session = await a.createSession({ source: 'note', title: 'Stays where it is', spaceId: space.id, text: 'x' });
    renderApp(`/sessions/${session.id}`, a);
    await act(() => a.capabilities());
    await user.click(await screen.findByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Open space' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Move to another space…' })).not.toBeInTheDocument();
  });
});
