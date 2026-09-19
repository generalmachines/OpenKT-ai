/**
 * The sample workspace as a visitor meets it: in from the Welcome screen, a
 * living page with a fork and a change, a space they can only read, who
 * contributes what, the graph — and out again to sign up. And with a real
 * account, none of it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFakeServer } from '../../test/support/fake-server';
import { DEFAULT_SERVER_URL, type ApiSettings } from '../api';
import { ApiProvider } from '../api/hooks';
import { MockClient } from '../api/mock';
import { ConnectionProvider } from '../state/connection';
import { AppRoutes } from './AppRoutes';

function renderSample(route: string) {
  render(
    <ApiProvider client={new MockClient()}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </ApiProvider>,
  );
  return userEvent.setup();
}

function renderConnected(initial: Partial<ApiSettings>, route: string) {
  render(
    <ConnectionProvider initial={{ adapter: 'mock', baseUrl: DEFAULT_SERVER_URL, token: '', ...initial }}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </ConnectionProvider>,
  );
  return userEvent.setup();
}

afterEach(() => localStorage.clear());

describe('the sample workspace', () => {
  it('is a visible second way in from Welcome, says what it is, and hands over to sign-up', async () => {
    localStorage.setItem('openkt.onboarded', '1');
    const user = renderConnected({ signedOut: true }, '/welcome');
    await user.click(await screen.findByRole('button', { name: 'See a demo with sample data' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Acmeflow deal review' })).toBeInTheDocument();
    const banner = screen.getByRole('note', { name: 'Sample workspace' });
    expect(banner).toHaveTextContent('Sample workspace — sign up to use your own');

    await user.click(within(banner).getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'Sample workspace' })).not.toBeInTheDocument();
  });

  it('a page shows both sides of a fork, attributed, and what changed with the old position struck through', async () => {
    renderSample('/pages/p-sales-trial-poc-management');
    expect(await screen.findByRole('heading', { level: 1, name: 'Trial & POC Management' })).toBeInTheDocument();
    const changes = screen.getByRole('list', { name: 'What changed' });
    expect(within(changes).getByText('14-day standard trial length with AE ownership model').tagName).toBe('S');
    expect(within(changes).getByText(/30-day standard trial length/)).toBeInTheDocument();
    // The superseded fact keeps its place under "Who said what", struck through.
    expect(screen.getByText('Standard POC trial length is 14 days; AE owns the trial close.').tagName).toBe('S');
    expect(screen.getByRole('region', { name: 'Related pages' })).toHaveTextContent('Sales-to-Customer Success Handoff & Renewal Management');
    expect(within(screen.getByRole('complementary', { name: 'Sources' })).getByRole('list', { name: 'People on this page' })).toHaveTextContent('Marcus');

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /Sales-to-Customer Success Handoff/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales-to-Customer Success Handoff & Renewal Management' })).toBeInTheDocument();
  });

  it('a fork keeps two people’s positions in their words', async () => {
    renderSample('/pages/p-sales-sales-presentation-deal');
    const fork = await screen.findByRole('group', { name: 'Open disagreement: Competitive positioning: price vs. differentiation' });
    expect(within(fork).getByText('Marcus')).toBeInTheDocument();
    expect(within(fork).getByText('Tomas')).toBeInTheDocument();
    expect(fork).toHaveTextContent('we win on 20% list price advantage vs Acmeflow');
    expect(fork).toHaveTextContent('lead with security/compliance depth instead');
  });

  it('a reader sees who to ask for edit access, and no Edit button', async () => {
    const user = renderSample('/spaces/sp-healthcare');
    expect(await screen.findByText('You can read healthcare. Ask Dr. Ekwueme for edit access.')).toBeInTheDocument();
    await user.click((await screen.findAllByRole('link', { name: /^Inpatient Glucose Management/ }))[0]!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Inpatient Glucose Management' })).toBeInTheDocument();
    expect(await screen.findByText('You can read healthcare. Ask Dr. Ekwueme for edit access.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('the space shows who contributes what, and links to the graph', async () => {
    const user = renderSample('/spaces/sp-sales');
    const people = await screen.findByRole('region', { name: 'Who contributes what' });
    expect(within(people).getByText('Dana')).toBeInTheDocument();
    expect(people).toHaveTextContent('VP Sales');
    expect(people).toHaveTextContent('8 facts');
    expect(screen.queryByText(/Ask .* for edit access/)).not.toBeInTheDocument(); // an editor here

    await user.click(screen.getByRole('link', { name: 'See how it connects' }));
    const graph = await screen.findByRole('group', { name: 'Knowledge graph of sales' });
    await user.click(within(graph).getByRole('button', { name: 'page: Pricing Strategy & Deal Economics' }));
    const detail = screen.getByRole('complementary', { name: 'Selected' });
    expect(detail).toHaveTextContent('Pricing Strategy & Deal Economics');
    await user.click(within(detail).getByRole('link', { name: 'Open the page' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing Strategy & Deal Economics' })).toBeInTheDocument();
  });

  it('⌘K recalls across teams with who said it, and marks what you can only read', async () => {
    const user = renderSample('/sessions/s-sales-acmeflow');
    await screen.findByRole('heading', { level: 1, name: 'Acmeflow deal review' });
    await user.keyboard('{Meta>}k{/Meta}');
    const dialog = await screen.findByRole('dialog', { name: 'Search all context' });
    await user.type(within(dialog).getByRole('combobox'), 'glucose');
    const context = await within(dialog).findByRole('group', { name: 'Context' });
    await waitFor(() => expect(within(context).getAllByRole('option').length).toBeGreaterThan(2));
    expect(within(context).getAllByRole('option')[0]).toHaveTextContent(/· healthcare · read only/);
    expect(context).toHaveTextContent('Dr. Ekwueme');
  });
});

describe('signed in to a real server', () => {
  const BASE = 'http://openkt.test';
  const fake = createFakeServer(BASE);
  const server = setupServer(...fake.handlers);
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  it('never shows the sample banner or any sample content', async () => {
    renderConnected({ adapter: 'http', baseUrl: BASE, token: fake.tokens.a }, '/spaces');
    expect(await screen.findByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/spaces/'))).toBe(true));
    expect(screen.queryByRole('note', { name: 'Sample workspace' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Acmeflow|Ekwueme|healthcare|hospitality|Sample workspace/);
  });
});
