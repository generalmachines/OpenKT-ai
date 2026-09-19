import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatusDto } from '../../shared/ipc';
import { UpdatePill } from '../../components/UpdatePill';
import { About } from './About';

const base: UpdateStatusDto = {
  version: '0.3.127',
  commit: '63a4d5f1234567',
  builtAt: '2026-09-19T09:00:00Z',
  channel: 'stable',
  mode: 'custom',
  phase: 'up-to-date',
  auto: true,
  lastCheckedAt: new Date().toISOString(),
  available: null,
  progress: null,
  error: null,
  location: { ok: true, message: null, canMove: false },
  whatsNew: null,
  rollback: null,
};

function withBridge(status: UpdateStatusDto) {
  let listener: ((s: UpdateStatusDto) => void) | null = null;
  const api = {
    status: vi.fn(async () => status),
    check: vi.fn(async () => ({ ...status, phase: 'checking' as const })),
    download: vi.fn(async () => status),
    install: vi.fn(async () => ({ ...status, phase: 'installing' as const })),
    setAuto: vi.fn(async (on: boolean) => ({ ...status, auto: on })),
    moveToApplications: vi.fn(async () => status),
    rollback: vi.fn(async () => status),
    seen: vi.fn(async () => ({ ...status, whatsNew: null })),
    onEvent: vi.fn((l: (s: UpdateStatusDto) => void) => ((listener = l), () => (listener = null))),
  };
  (window as unknown as { openkt: unknown }).openkt = { update: api };
  return { api, push: (s: UpdateStatusDto) => listener?.(s) };
}

const renderIn = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

afterEach(() => {
  delete (window as unknown as { openkt?: unknown }).openkt;
});

describe('Settings → About', () => {
  it('says honestly that there is no updater outside the desktop app', () => {
    renderIn(<About />);
    expect(screen.getByText(/not running inside it/)).toBeInTheDocument();
  });

  it('shows the version, commit, channel and the automatic-download switch (on by default)', async () => {
    const { api } = withBridge(base);
    const user = userEvent.setup();
    renderIn(<About />);
    expect(await screen.findByText('OpenKT 0.3.127')).toBeInTheDocument();
    expect(screen.getByText(/commit 63a4d5f/)).toBeInTheDocument();
    expect(screen.getByText('stable')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You have the latest version');
    const toggle = screen.getByRole('switch', { name: 'Download updates automatically' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(api.setAuto).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(api.check).toHaveBeenCalled();
  });

  it('shows progress while downloading, then "Restart to update" with the release notes', async () => {
    const available = { version: '0.3.128', notes: ['Sign in with email', 'Skills screen'], releasedAt: '', size: 180_000_000 };
    const { api, push } = withBridge({ ...base, phase: 'downloading', available, progress: { receivedBytes: 90_000_000, totalBytes: 180_000_000, bytesPerSec: 1 } });
    const user = userEvent.setup();
    renderIn(<About />);
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('Sign in with email')).toBeInTheDocument();
    push({ ...base, phase: 'ready', available });
    await user.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect(api.install).toHaveBeenCalled();
  });

  it('offers "Move to Applications" when running from the disk image', async () => {
    const { api } = withBridge({ ...base, location: { ok: false, message: 'OpenKT is running from the disk image. Drag it to Applications first — then it can update itself.', canMove: true } });
    const user = userEvent.setup();
    renderIn(<About />);
    await user.click(await screen.findByRole('button', { name: 'Move to Applications' }));
    expect(api.moveToApplications).toHaveBeenCalled();
  });

  it('shows "what\'s new" once and tells main it was seen', async () => {
    const { api } = withBridge({ ...base, whatsNew: { version: '0.3.127', from: '0.3.126', notes: ['Faster search'] } });
    renderIn(<About />);
    expect(await screen.findByText('Updated to 0.3.127 — what’s new')).toBeInTheDocument();
    expect(screen.getByText('Faster search')).toBeInTheDocument();
    await waitFor(() => expect(api.seen).toHaveBeenCalled());
    expect(screen.getByText('Faster search')).toBeInTheDocument();
  });
});

describe('sidebar update pill', () => {
  it('is hidden when there is nothing to do', async () => {
    const { api } = withBridge(base);
    const { container } = renderIn(<UpdatePill />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('"Update ready — Restart" installs', async () => {
    const { api } = withBridge({ ...base, phase: 'ready', available: { version: '0.3.128', notes: [], releasedAt: '', size: 1 } });
    const user = userEvent.setup();
    renderIn(<UpdatePill />);
    await user.click(await screen.findByRole('button', { name: 'Update ready — Restart' }));
    expect(api.install).toHaveBeenCalled();
  });

  it('links to About for "what\'s new"', async () => {
    withBridge({ ...base, whatsNew: { version: '0.3.127', from: '0.3.126', notes: [] } });
    renderIn(<UpdatePill />);
    expect(await screen.findByRole('link', { name: 'Updated to 0.3.127 — what’s new' })).toHaveAttribute('href', '/settings/about');
  });
});
