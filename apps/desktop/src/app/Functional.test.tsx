/**
 * The screens a signed-in person hits first, in the states the live journey (e2e/journey.mjs)
 * found broken: a brand-new account, a note saved without local AI, and a server that does
 * not answer. Each must be honest: real data, a plain empty state, or an error with Retry.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { ApiProvider } from '../api/hooks';
import { MockClient } from '../api/mock';
import type { PreviewArea, SessionListItem } from '../api/types';
import { AppRoutes } from './AppRoutes';

/** An account with nothing in it yet, whose connectors are still sample data (as on the http adapter). */
class NewAccount extends MockClient {
  constructor() {
    super();
    Object.defineProperty(this, 'preview', { value: new Set<PreviewArea>(['connectors']) });
  }
  override async listSessions(filter?: { spaceId?: string; mine?: boolean }): Promise<SessionListItem[]> {
    return (await super.listSessions(filter)).filter((s) => s.title.startsWith('Walrus'));
  }
}

/** The server went away (what main's net proxy reports when a request is blocked or the network is down). */
class Unreachable extends MockClient {
  down = true;
  private fail() {
    if (this.down) throw new ApiError('network', "Error invoking remote method 'net:request': Error: net::ERR_BLOCKED_BY_CLIENT");
  }
  override async listSessions(filter?: { spaceId?: string; mine?: boolean }) {
    this.fail();
    return super.listSessions(filter);
  }
  override async listSpaces() {
    this.fail();
    return super.listSpaces();
  }
  override async recall(query: string, opts?: { spaceId?: string; limit?: number }) {
    this.fail();
    return super.recall(query, opts);
  }
}

function renderApp(route: string, client: MockClient) {
  render(
    <ApiProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </ApiProvider>,
  );
  return client;
}

describe('a brand-new account', () => {
  it('says there are no sessions yet instead of leaving a blank sidebar, and lands on a new note', async () => {
    renderApp('/', new NewAccount());
    const nav = await screen.findByRole('navigation', { name: 'Sessions' });
    expect(await within(nav).findByText(/No sessions yet/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Note')).toBeInTheDocument();
  });

  it('a note saved without local AI keeps the note as its context, so it can be recalled', async () => {
    const user = userEvent.setup();
    const client = renderApp('/new', new NewAccount());
    await user.type(screen.getByLabelText('Title'), 'Walrus pricing');
    await user.type(screen.getByLabelText('Note'), 'We quote the Walrus Grocers account per store, not per seat.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Walrus pricing' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Context · 1' })).toBeInTheDocument();
    const session = (await client.listSessions({ mine: true }))[0]!;
    const context = await client.listContext(session.id);
    expect(context.map((c) => c.statement)).toEqual(['Walrus pricing\n\nWe quote the Walrus Grocers account per store, not per seat.']);
    // Nothing ran on this Mac, so the session does not say it did.
    expect(screen.getByText('saved as written')).toBeInTheDocument();
    expect(screen.queryByText('extracted on this Mac')).not.toBeInTheDocument();
    // No tool is connected on this machine, so the footer claims none.
    expect(screen.queryByText(/retrievable from [1-9]\d* connected/)).not.toBeInTheDocument();
  });
});

describe('the server does not answer', () => {
  it('says so with Retry — in the sidebar, on the home screen and in ⌘K — and Retry recovers', async () => {
    const user = userEvent.setup();
    const client = renderApp('/', new Unreachable()) as Unreachable;

    const nav = await screen.findByRole('navigation', { name: 'Sessions' });
    expect(await within(nav).findByText('Can’t reach the OpenKT server. Check your connection, then retry.')).toBeInTheDocument();
    expect(screen.queryByText(/ERR_BLOCKED_BY_CLIENT/)).not.toBeInTheDocument();
    // Not a blank note editor that cannot be saved.
    expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThanOrEqual(2);

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Search all context' });
    await user.type(within(dialog).getByRole('combobox'), 'acmeflow');
    expect(await within(dialog).findByText(/Can’t reach the OpenKT server/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Nothing relevant/)).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    client.down = false;
    await user.click(within(nav).getByRole('button', { name: 'Retry' }));
    expect(await within(nav).findByText('Acmeflow deal review')).toBeInTheDocument();
  });
});
