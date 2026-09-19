/**
 * The sign-in experience, end to end in jsdom: the real routes, the real
 * ConnectionProvider, the real http auth client — against msw handlers that
 * mirror the server's `/v1/auth/*` contract (test/support/fake-server.ts).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeServer } from '../../test/support/fake-server';
import { describeAuthError } from '../api/auth';
import { ApiError } from '../api/errors';
import { DEFAULT_SERVER_URL, type ApiSettings } from '../api';
import { AppRoutes } from '../app/AppRoutes';
import { ConnectionProvider } from '../state/connection';

const BASE = 'http://openkt.test';
let fake = createFakeServer(BASE);
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  delete window.openkt;
});
afterAll(() => server.close());

function renderApp(initial: Partial<ApiSettings> = {}, route = '/') {
  fake = createFakeServer(BASE);
  server.use(...fake.handlers);
  render(
    <ConnectionProvider initial={{ adapter: 'http', baseUrl: BASE, token: '', ...initial }}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </ConnectionProvider>,
  );
  return userEvent.setup();
}

/** A plain browser in sample mode, signed out: the hosted default, nothing remembered. */
const SAMPLE: Partial<ApiSettings> = { adapter: 'mock', baseUrl: DEFAULT_SERVER_URL, signedOut: true };

const stored = (): Partial<ApiSettings> => JSON.parse(localStorage.getItem('openkt.api') ?? '{}') as Partial<ApiSettings>;
const inShell = () => screen.findByRole('navigation', { name: 'Sessions' });

describe('Welcome — signing in', () => {
  it('is what a signed-out person sees, with no developer words on it', async () => {
    renderApp(SAMPLE);
    expect(await screen.findByRole('heading', { level: 1, name: 'OpenKT' })).toBeInTheDocument();
    expect(screen.getByText('Your team’s shared context, in every AI tool.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByText('or')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(document.querySelector('main')!.textContent).not.toMatch(/server|token|endpoint|\bPAT\b|\bURL\b|\bAPI\b/i);
    // …apart from the one quiet link, which is the only way to the advanced area.
    expect(screen.getByRole('button', { name: 'Using your own server?' })).toBeInTheDocument();
  });

  it('works with a password manager: a real form, username + current-password', async () => {
    renderApp();
    const form = await screen.findByRole('form', { name: 'Sign in' });
    expect(form.tagName).toBe('FORM');
    expect(within(form).getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(within(form).getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(within(form).getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(within(form).getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
  });

  it('happy path: email + password, Enter submits, lands in the app, token and email are remembered', async () => {
    const user = renderApp();
    await user.type(await screen.findByLabelText('Email'), 'pratham@openkt.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery{Enter}');
    expect(await inShell()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(stored()).toMatchObject({ adapter: 'http', baseUrl: BASE, token: fake.tokens.a, email: 'pratham@openkt.test' });
  });

  it('shows a spinner state on the button while the request is in flight', async () => {
    const user = renderApp();
    let release = () => {};
    server.use(http.post(`${BASE}/v1/auth/login`, () => new Promise<never>((_r, reject) => (release = () => reject(new Error('gone'))))));
    await user.type(await screen.findByLabelText('Email'), 'pratham@openkt.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(button.querySelector('.spinner')).not.toBeNull();
    release();
  });

  it.each([
    ['a wrong password', async () => undefined, 'That email and password don’t match.'],
    ['too many tries', async () => void (fake.state.rateLimited = true), 'Too many tries. Wait a few minutes and try again.'],
    ['no connection', async () => server.use(http.post(`${BASE}/v1/auth/login`, () => HttpResponse.error())), 'Can’t reach that server. Check the address and your connection.'],
  ])('%s → one human sentence, and the email stays put', async (_name, arrange, message) => {
    const user = renderApp();
    await arrange();
    await user.type(await screen.findByLabelText('Email'), 'pratham@openkt.test');
    await user.type(screen.getByLabelText('Password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Email')).toHaveValue('pratham@openkt.test');
    // Typing again clears the message.
    await user.type(screen.getByLabelText('Password'), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks for what is missing before bothering the server', async () => {
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your email address.');
    await user.type(screen.getByLabelText('Email'), 'pratham@');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That email address doesn’t look right.');
  });

  it('maps every error code the server can send', () => {
    const e = (kind: ConstructorParameters<typeof ApiError>[0], status: number, code: string) => new ApiError(kind, 'server text', status, code);
    expect(describeAuthError(e('unauthorized', 401, 'invalid_credentials'), 'signin')).toBe('That email and password don’t match.');
    expect(describeAuthError(e('conflict', 409, 'email_taken'), 'signup')).toBe('There’s already an account with that email — sign in instead.');
    expect(describeAuthError(e('invalid', 400, 'weak_password'), 'signup')).toBe('Choose a longer password — at least 10 characters.');
    expect(describeAuthError(new ApiError('invalid', 'that password is too common — choose another', 400, 'weak_password'), 'signup')).toBe('That password is too easy to guess. Choose another.');
    expect(describeAuthError(e('rate-limited', 429, 'rate_limited'), 'signin')).toBe('Too many tries. Wait a few minutes and try again.');
    expect(describeAuthError(e('not-found', 404, 'provider_disabled'), 'google')).toBe('Google sign-in isn’t available here. Use your email and password.');
    expect(describeAuthError(e('network', 0, ''), 'signin')).toBe('Can’t reach OpenKT right now. Check your connection.');
    expect(describeAuthError(e('unauthorized', 401, 'unauthorized'), 'token')).toBe('That access token didn’t work. Check it and try again.');
    for (const msg of [describeAuthError(e('server', 500, 'internal'), 'signin'), describeAuthError(new Error('boom'), 'signin')]) expect(msg).not.toMatch(/server text|boom|500/);
  });
});

describe('Welcome — creating an account', () => {
  it('the same card switches to sign-up: name, password hint, new-password, and back again', async () => {
    const user = renderApp();
    await user.type(await screen.findByLabelText('Email'), 'someone@new.test');
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    const form = screen.getByRole('form', { name: 'Create an account' });
    expect(within(form).getByLabelText('Your name')).toHaveAttribute('autocomplete', 'name');
    expect(within(form).getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(within(form).getByText('At least 10 characters')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(within(form).getByLabelText('Email')).toHaveValue('someone@new.test');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('someone@new.test');
  });

  it('a new person continues into onboarding (connect tools → models), signed in', async () => {
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Your name'), 'Noor Haddad');
    await user.type(screen.getByLabelText('Email'), 'noor@new.test');
    await user.type(screen.getByLabelText('Password'), 'a long enough password{Enter}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Connect your tools' })).toBeInTheDocument();
    expect(await screen.findByText('Signed in as Noor Haddad.')).toBeInTheDocument();
    expect(stored()).toMatchObject({ email: 'noor@new.test' });
    expect(stored().token).toMatch(/^okt_pat_/);
  });

  it('an email that already has an account, and a short password, each get their sentence', async () => {
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Your name'), 'Pratham');
    await user.type(screen.getByLabelText('Email'), 'pratham@openkt.test');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a longer password — at least 10 characters.');

    await user.type(screen.getByLabelText('Password'), ' but now long enough');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There’s already an account with that email — sign in instead.');
    expect(screen.getByLabelText('Email')).toHaveValue('pratham@openkt.test');
  });
});

describe('Welcome — the advanced area', () => {
  it('is hidden by default; the quiet link reveals one "Server address" field, then the access-token path', async () => {
    const user = renderApp(SAMPLE);
    await screen.findByRole('heading', { level: 1, name: 'OpenKT' });
    expect(screen.queryByLabelText('Server address')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    expect(screen.queryByText(/access token/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Using your own server?' }));
    expect(screen.getByLabelText('Server address')).toHaveValue('');
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in with an access token' }));
    expect(screen.getByLabelText('Access token')).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use email and password instead' }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('signs in to a server of your own with an access token, and remembers that server', async () => {
    const user = renderApp(SAMPLE);
    await user.click(await screen.findByRole('button', { name: 'Using your own server?' }));
    await user.type(screen.getByLabelText('Server address'), 'openkt.test:80');
    await user.click(screen.getByRole('button', { name: 'Sign in with an access token' }));
    await user.type(screen.getByLabelText('Access token'), 'okt_pat_wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That access token didn’t work. Check it and try again.');

    await user.clear(screen.getByLabelText('Access token'));
    await user.type(screen.getByLabelText('Access token'), `${fake.tokens.a}{Enter}`);
    expect(await inShell()).toBeInTheDocument();
    expect(stored()).toMatchObject({ adapter: 'http', baseUrl: 'http://openkt.test:80', token: fake.tokens.a, email: 'pratham@openkt.test' });
  });

  it('a remembered server of your own is named quietly at the bottom, and can be changed', async () => {
    const user = renderApp();
    const quiet = await screen.findByRole('button', { name: 'Signing in to openkt.test · Change' });
    await user.click(quiet);
    expect(screen.getByLabelText('Server address')).toHaveValue(BASE);
  });
});

describe('Welcome — Google', () => {
  /** The Electron bridge, as far as this screen and the shell need it. */
  function bridge(start: () => Promise<unknown>) {
    const cancel = vi.fn(async (): Promise<void> => undefined);
    window.openkt = {
      platform: 'test',
      app: { onNavigate: () => () => undefined, hotkeys: async () => [], openMain: async () => undefined },
      capture: { onEvent: () => () => undefined },
      auth: { google: { start: vi.fn(start), cancel } },
    } as unknown as NonNullable<Window['openkt']>;
    return { cancel, start: window.openkt!.auth.google.start as ReturnType<typeof vi.fn> };
  }

  it('hands the client id from the server to main, posts the id_token back, and a first-timer on this Mac gets onboarding', async () => {
    const b = bridge(async () => ({ id_token: 'google:noor@gmail.test:Noor Haddad' }));
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Connect your tools' })).toBeInTheDocument();
    expect(b.start).toHaveBeenCalledWith({ clientId: 'test-client.apps.googleusercontent.com', clientSecret: undefined });
    expect(stored()).toMatchObject({ email: 'noor@gmail.test' });
  });

  it('someone who has been through onboarding here lands on their sessions', async () => {
    localStorage.setItem('openkt.onboarded', '1');
    bridge(async () => ({ id_token: 'google:pratham@openkt.test' }));
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await inShell()).toBeInTheDocument();
  });

  it('while the browser is open the app waits, and Cancel is one click; cancelling is not an error', async () => {
    let settle = (_v: unknown) => {};
    const b = bridge(() => new Promise((r) => (settle = r)));
    b.cancel.mockImplementation(async () => void settle({ error: 'cancelled', message: 'cancelled' }));
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Waiting for Google…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a timeout says so', async () => {
    bridge(async () => ({ error: 'timeout', message: 'timeout' }));
    const user = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in took too long. Try again.');
  });

  it('no Google button when the server has not enabled it, or when there is no system browser to open', async () => {
    renderApp(); // no Electron bridge
    await screen.findByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(screen.queryByText('or')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  });

  it('…and none when the server says Google is off', async () => {
    bridge(async () => ({ id_token: 'x' }));
    renderApp();
    fake.state.google = { enabled: false };
    await screen.findByRole('button', { name: 'Sign in' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  });
});

describe('signing out, and sessions that end', () => {
  it('Settings → Account shows name and email; Sign out tells the server, forgets the token, returns to Welcome with the email filled in', async () => {
    const user = renderApp({ token: 'okt_pat_aaaa', email: 'pratham@openkt.test' }, '/settings/account');
    const row = (await screen.findByText('Pratham Bhatnagar')).closest('li')!;
    expect(within(row).getByText('pratham@openkt.test')).toBeInTheDocument();
    expect(document.querySelector('main')!.textContent).not.toMatch(/token|keychain|http/i);

    await user.click(within(row).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'OpenKT' })).toBeInTheDocument();
    expect(fake.revoked.has('okt_pat_aaaa')).toBe(true);
    expect(stored().token ?? '').toBe('');
    expect(screen.getByLabelText('Email')).toHaveValue('pratham@openkt.test');
    expect(screen.queryByText('Please sign in again.')).not.toBeInTheDocument();
  });

  it('a 401 anywhere → Welcome, "Please sign in again.", email prefilled, token dropped', async () => {
    renderApp({ token: 'okt_pat_no_longer_valid', email: 'pratham@openkt.test' }, '/spaces');
    expect(await screen.findByText('Please sign in again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('pratham@openkt.test');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await waitFor(() => expect(stored().token ?? '').toBe(''));
  });
});
