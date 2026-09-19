import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiProvider } from '../api/hooks';
import { MockClient } from '../api/mock';
import { AppRoutes } from './AppRoutes';

function renderApp(route: string, client = new MockClient()) {
  render(
    <ApiProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </ApiProvider>,
  );
  return client;
}

const SESSION = '/sessions/s-northgate-pricing';

describe('routing', () => {
  it('opens the most recent session from "/"', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing call with Northgate' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Quote Northgate per store, not per seat')).toBeInTheDocument();
  });

  it('groups the sidebar into Today and Yesterday', async () => {
    renderApp(SESSION);
    const today = await screen.findByRole('group', { name: 'Today' });
    expect(within(today).getAllByRole('link')).toHaveLength(3);
    const yesterday = screen.getByRole('group', { name: 'Yesterday' });
    expect(within(yesterday).getByText('Hiring plan notes')).toBeInTheDocument();
  });

  it('switches session tabs by route', async () => {
    const user = userEvent.setup();
    renderApp(SESSION);
    await user.click(await screen.findByRole('tab', { name: 'Transcript' }));
    expect(await screen.findByText(/We think in stores, not seats/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Context · 6/ }));
    expect(await screen.findByText('“Then let us quote per store, not per seat.”')).toBeInTheDocument();
  });

  it('walks Spaces → space → living page with its sources', async () => {
    const user = userEvent.setup();
    renderApp(SESSION);
    await user.click(await screen.findByRole('link', { name: 'Spaces' }));
    await user.click(await screen.findByRole('link', { name: /sales \/ northgate/ }));
    await user.click(await screen.findByRole('link', { name: /Northgate — pricing/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Northgate — pricing' })).toBeInTheDocument();
    const sources = screen.getByRole('complementary', { name: 'Sources' });
    expect(within(sources).getAllByRole('link')).toHaveLength(4);
    expect(within(sources).getByText('Draft proposal v1')).toBeInTheDocument();
  });

  it('renders settings sections and the decided models', async () => {
    renderApp('/settings/models');
    expect(await screen.findByText('Qwen3-Embedding-0.6B')).toBeInTheDocument();
    expect(screen.getByText('Qwen3-Reranker-0.6B')).toBeInTheDocument();
    expect(screen.getByText('Omnilingual ASR 300M')).toBeInTheDocument();
    expect(screen.getByText('Parakeet (streaming)')).toBeInTheDocument();
    expect(screen.getAllByText('Qwen3.5-4B')).toHaveLength(2);
  });

  it('renders the capture previews outside the shell', () => {
    renderApp('/capture/meeting');
    expect(screen.getByText('Google Meet is using your mic')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).not.toBeInTheDocument();
  });
});

describe('access', () => {
  it('changing a role mutates the mock store and the row', async () => {
    const user = userEvent.setup();
    const client = renderApp(`${SESSION}/access`);
    const resource = { type: 'session' as const, id: 's-northgate-pricing' };

    await user.click(await screen.findByRole('button', { name: 'Role for Ojas Sinha: Reader' }));
    await user.click(screen.getByRole('option', { name: 'Editor' }));

    await waitFor(async () => {
      const grants = await client.listGrants(resource);
      expect(grants.find((g) => g.subject.id === 'u-ojas')?.role).toBe('editor');
    });
    expect(await screen.findByRole('button', { name: 'Role for Ojas Sinha: Editor' })).toBeInTheDocument();
  });

  it('removing access deletes the grant; inherited grants cannot be removed', async () => {
    const user = userEvent.setup();
    const client = renderApp(`${SESSION}/access`);

    await user.click(await screen.findByRole('button', { name: /Role for Sales team/ }));
    expect(screen.queryByRole('option', { name: 'Remove access' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /Role for Ana Reyes/ }));
    await user.click(screen.getByRole('option', { name: 'Remove access' }));
    await waitFor(() => expect(screen.queryByText('Ana Reyes')).not.toBeInTheDocument());
    const grants = await client.listGrants({ type: 'session', id: 's-northgate-pricing' });
    expect(grants.map((g) => g.subject.id)).not.toContain('u-ana');
  });

  it('invites a teammate as reader', async () => {
    const user = userEvent.setup();
    const client = renderApp(`${SESSION}/access`);
    await user.type(await screen.findByLabelText('Add people or teams'), 'ravi');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Ravi Menon')).toBeInTheDocument();
    const grants = await client.listGrants({ type: 'session', id: 's-northgate-pricing' });
    expect(grants.find((g) => g.subject.id === 'u-ravi')?.role).toBe('reader');
  });
});

describe('connectors', () => {
  it('changes a connector default in the store', async () => {
    const user = userEvent.setup();
    const client = renderApp('/settings/connectors');
    await user.click(await screen.findByRole('button', { name: /New ChatGPT sessions are shared with: Only me/ }));
    await user.click(screen.getByRole('option', { name: 'Everyone in Deepwork · read' }));
    await waitFor(async () => {
      const list = await client.listConnectors();
      expect(list.find((c) => c.id === 'chatgpt')?.defaultAccess).toBe('workspace-read');
    });
  });
});

describe('⌘K palette', () => {
  it('opens on ⌘K, filters, and navigates on Enter', async () => {
    const user = userEvent.setup();
    renderApp(SESSION);
    await screen.findByRole('heading', { level: 1, name: 'Pricing call with Northgate' });

    await user.keyboard('{Meta>}k{/Meta}');
    const dialog = await screen.findByRole('dialog', { name: 'Search all context' });
    await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(5));

    await user.type(within(dialog).getByRole('combobox'), 'refresh');
    await waitFor(() => {
      const titles = within(dialog)
        .getAllByRole('option')
        .map((o) => o.textContent ?? '');
      expect(titles.length).toBeGreaterThan(0);
      expect(titles.every((t) => /refresh/i.test(t))).toBe(true);
    });
    expect(within(dialog).queryByText('Hiring plan notes')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Fix auth refresh storm' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when nothing matches, and closes on Escape', async () => {
    const user = userEvent.setup();
    renderApp(SESSION);
    await user.click(await screen.findByRole('button', { name: /Search all context/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'zzzz');
    expect(await within(dialog).findByText(/Nothing relevant for “zzzz”/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('onboarding', () => {
  it('counts the tools that are ticked', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding/2');
    expect(screen.getByRole('button', { name: 'Connect 4 tools' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    expect(screen.getByRole('button', { name: 'Connect 5 tools' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Cursor' }));
    expect(screen.getByRole('checkbox', { name: 'Cursor' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Connect 4 tools' })).toBeInTheDocument();
  });
});
