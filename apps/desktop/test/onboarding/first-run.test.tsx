/**
 * The first run in the renderer, against a FAKE bridge (test/support/first-run.ts) and the
 * mock adapter: permissions (every state → one button), step persistence and the relaunch
 * resume, the on-device AI screen (auto-start, progress, pause/resume, error + retry, low disk,
 * small RAM), the Try-it cards, the sidebar indicator and Settings → Permissions.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/hooks';
import { MockClient } from '../../src/api/mock';
import { AppRoutes } from '../../src/app/AppRoutes';
import { beginProgress, markSkipped, markTried, PROGRESS_KEY, readProgress, resumeStep, setStep } from '../../src/onboarding/state';
import { etaSeconds, formatEta, percent, setupPhase } from '../../src/onboarding/models';
import { VoiceCapture } from '../../src/screens/capture/VoiceCapture';
import { GiB, installFirstRun, rows, uninstall } from '../support/first-run';

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

const railStep = (title: string) => screen.getByText(title, { selector: '.step__title' }).closest('li') as HTMLElement;

beforeEach(() => localStorage.clear());
afterEach(() => {
  uninstall();
  localStorage.clear();
});

describe('onboarding progress on this Mac', () => {
  it('starts at step 2, keeps the step, and remembers "later" as later — never as done', () => {
    expect(readProgress()).toBeNull();
    expect(beginProgress().step).toBe(2);
    setStep(4);
    markSkipped(3);
    markTried('note');
    markTried('note');
    expect(readProgress()).toMatchObject({ step: 4, skipped: [3], tried: ['note'] });
  });

  it('ignores a damaged record instead of crashing', () => {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ step: 9, skipped: [3, 'x', 7], tried: ['voice', 'nope'] }));
    expect(readProgress()).toMatchObject({ step: 2, skipped: [3], tried: ['voice'] });
    localStorage.setItem(PROGRESS_KEY, '{not json');
    expect(readProgress()).toBeNull();
  });

  it('"/" resumes an unfinished first run; the desktop app starts one for someone who signed in on a new Mac', () => {
    expect(resumeStep(false, false)).toBeNull(); // a browser, nothing started: straight to sessions
    expect(resumeStep(false, true)).toBe(2);
    setStep(5);
    expect(resumeStep(false, false)).toBe(5);
    expect(resumeStep(true, true)).toBeNull();
  });

  it('after a relaunch (Screen Recording) the app opens "/" and lands back on the same step', async () => {
    installFirstRun({ perms: { microphone: 'granted' } });
    setStep(2);
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 2, name: 'Allow access' })).toBeInTheDocument();
  });

  it('finished onboarding: "/" opens the sessions', async () => {
    installFirstRun();
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing call with Northgate' })).toBeInTheDocument();
  });
});

describe('step 2 — permissions', () => {
  it('shows three rows with a live pill and ONE button each, plus meetings as coming soon', async () => {
    installFirstRun({ perms: { microphone: 'not-determined', screen: 'denied', accessibility: 'granted', systemAudio: 'denied' } });
    renderApp('/onboarding/2');
    const list = await screen.findByRole('list', { name: 'Permissions' });
    const row = (name: string) => within(list).getByText(name, { selector: '.person__name' }).closest('li') as HTMLElement;
    expect(within(row('Microphone')).getByRole('status')).toHaveTextContent('Not asked yet');
    expect(within(row('Microphone')).getAllByRole('button')).toHaveLength(1);
    expect(within(row('Microphone')).getByRole('button', { name: 'Allow: Microphone' })).toBeInTheDocument();
    expect(within(row('Screen Recording')).getByRole('button', { name: 'Open System Settings: Screen Recording' })).toBeInTheDocument();
    expect(within(row('Accessibility')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('Accessibility')).getByText('Granted')).toBeInTheDocument();
    expect(within(list).getByText('coming soon')).toBeInTheDocument();
    expect(within(list).getByText('Included with Screen Recording')).toBeInTheDocument();
    expect(screen.getByText(/processed on this Mac/)).toBeInTheDocument();
    expect(screen.getByText('How this works on a Mac')).toBeInTheDocument();
  });

  it('Continue waits for the microphone answer — yes or no — and the rows follow what macOS says', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun();
    renderApp('/onboarding/2');
    const cont = await screen.findByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Allow: Microphone' }));
    expect(fake.bridge.permissions.request).toHaveBeenCalledWith('microphone');
    await waitFor(() => expect(cont).toBeEnabled());
    // the poll pushes a change made in System Settings
    act(() => fake.setPerms({ microphone: 'denied' }));
    expect(await screen.findByRole('button', { name: 'Open System Settings: Microphone' })).toBeInTheDocument();
    expect(cont).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Open System Settings: Microphone' }));
    expect(fake.bridge.permissions.openSettings).toHaveBeenCalledWith('microphone');
    await user.click(cont);
    expect(await screen.findByRole('heading', { level: 2, name: 'Connect your tools' })).toBeInTheDocument();
    expect(readProgress()?.step).toBe(3);
  });

  it('after Screen Recording is sent to System Settings, "Relaunch OpenKT" appears and relaunches', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ perms: { microphone: 'granted', screen: 'denied', relaunchSuggested: true } });
    renderApp('/onboarding/2');
    await user.click(await screen.findByRole('button', { name: 'Relaunch OpenKT' }));
    expect(fake.bridge.permissions.relaunch).toHaveBeenCalled();
    // the step is on disk before the process goes away
    expect(readProgress()?.step).toBe(2);
  });

  it('"Do this later" moves on and the rail says later, with the reminder in Settings', async () => {
    const user = userEvent.setup();
    installFirstRun();
    renderApp('/onboarding/2');
    await user.click(await screen.findByRole('button', { name: /Do this later/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Connect your tools' })).toBeInTheDocument();
    expect(railStep('Allow access')).toHaveClass('step--later');
    expect(within(railStep('Allow access')).getByText(/Later — Settings → Permissions/)).toBeInTheDocument();
    expect(readProgress()?.skipped).toEqual([2]);
  });

  it('not a Mac: the step moves straight on, and the rail says there was nothing to allow', async () => {
    renderApp('/onboarding/2'); // no bridge at all
    expect(await screen.findByRole('heading', { level: 2, name: 'Connect your tools' })).toBeInTheDocument();
    expect(within(railStep('Allow access')).getByText('Nothing to allow on this computer.')).toBeInTheDocument();
    expect(readProgress()?.skipped).toEqual([]);
  });
});

describe('step 4 — on-device AI', () => {
  it('is a choice: each open-source model with its job, licence and model card, the total — and nothing starts until asked', async () => {
    const fake = installFirstRun();
    renderApp('/onboarding/4');
    expect(await screen.findByText('4.6 GB in total, downloaded once.')).toBeInTheDocument();
    expect(screen.getByText('Everything runs on this Mac — nothing is sent to a cloud model.')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Models on this Mac' });
    const llm = within(list).getByRole('link', { name: 'Qwen3.5-4B' });
    expect(llm).toHaveAttribute('href', 'https://huggingface.co/Qwen/Qwen3.5-4B');
    expect(llm).toHaveAttribute('target', '_blank');
    expect(within(list).getByRole('link', { name: 'Whisper large-v3-turbo' })).toHaveAttribute('href', 'https://huggingface.co/openai/whisper-large-v3-turbo');
    expect(within(list).getByRole('link', { name: 'Qwen3-Embedding-0.6B' })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Qwen3.5-4B vision' })).toBeInTheDocument();
    expect(within(list).getAllByText(/· Apache-2\.0/)).toHaveLength(3);
    expect(within(list).getByText(/· MIT/)).toBeInTheDocument();
    for (const job of ['Search', 'Understanding', 'Speech', 'Images']) expect(within(list).getByText(job)).toBeInTheDocument();
    expect(within(list).getByText('2.7 GB')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download models (4.6 GB)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Later' })).toBeEnabled();
    expect(screen.getByText('llama.cpp · MIT')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.bridge.models.ensure).not.toHaveBeenCalled();
  });

  it('"Download models" starts it — everything — and then shows real progress; the person can carry on', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ ensure: () => new Promise(() => undefined) });
    renderApp('/onboarding/4');
    await user.click(await screen.findByRole('button', { name: 'Download models (4.6 GB)' }));
    expect(fake.bridge.models.ensure).toHaveBeenCalledWith(undefined);
    act(() => fake.progress({ role: 'embed', state: 'ready', receivedBytes: 639_150_592 }));
    act(() => fake.progress({ role: 'llm', state: 'downloading', receivedBytes: 1_370_468_944, bytesPerSec: 20e6 }));
    expect(screen.getByRole('progressbar', { name: 'Understanding download' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('progressbar', { name: 'Search download' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText(/50% · 1\.4 GB of 2\.7 GB/)).toBeInTheDocument();
    expect(screen.getByText(/20\.0 MB\/s · about 2 min left/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download models/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('"Later" moves on without downloading; the rail says later, and Settings → Models keeps a Download entry with a reminder chip', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun();
    renderApp('/onboarding/4');
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Try it' })).toBeInTheDocument();
    expect(railStep('Set up on-device AI')).toHaveClass('step--later');
    expect(within(railStep('Set up on-device AI')).getByText('Later — Settings → Models.')).toBeInTheDocument();
    expect(readProgress()?.skipped).toEqual([4]);
    expect(fake.bridge.models.ensure).not.toHaveBeenCalled();
  });

  it('Settings → Models before a download: a clear "Download on-device AI" entry, a chip in the nav, and the sidebar entry', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ ensure: () => new Promise(() => undefined) });
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/settings/models');
    expect(await screen.findByText('Download on-device AI', { selector: '.card__title' })).toBeInTheDocument();
    expect(await screen.findByLabelText('On-device AI not downloaded')).toHaveTextContent('not set up');
    expect(screen.getByRole('link', { name: 'Download on-device AI, 4.6 GB' })).toHaveAttribute('href', '/settings/models');
    await user.click(screen.getByRole('button', { name: 'Download models (4.6 GB)' }));
    expect(fake.bridge.models.ensure).toHaveBeenCalledWith(undefined);
  });

  it('pause and resume (resume continues the same models)', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ ensure: () => new Promise(() => undefined) });
    renderApp('/onboarding/4');
    await user.click(await screen.findByRole('button', { name: 'Download models (4.6 GB)' }));
    act(() => fake.progress({ role: 'embed', state: 'downloading', receivedBytes: 100e6, bytesPerSec: 5e6 }));
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(fake.bridge.models.pause).toHaveBeenCalled();
    act(() => fake.progress({ role: 'embed', state: 'partial', receivedBytes: 100e6 }));
    expect(await screen.findByText(/paused at \d+% · what arrived is kept/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(fake.bridge.models.resume).toHaveBeenCalled();
    expect(fake.bridge.models.ensure).toHaveBeenCalledTimes(1);
  });

  it('an error says so in plain words and "Try again" continues', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ info: { chosen: true } });
    fake.setRows(rows({ embed: { state: 'error', receivedBytes: 300e6, error: 'gave up on https://huggingface.co/x after 5 attempts: fetch failed' } }));
    renderApp('/onboarding/4');
    expect(await screen.findByText('The download stopped. Check the internet connection, then try again.')).toBeInTheDocument();
    expect(screen.queryByText(/gave up/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(fake.bridge.models.resume).toHaveBeenCalled();
  });

  it('low disk: checked before anything starts, Download stays off, and it says how much room is needed', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ info: { enoughDisk: false, freeBytes: 2e9, neededBytes: 5.7e9 } });
    renderApp('/onboarding/4');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not enough space on this Mac');
    expect(alert).toHaveTextContent('OpenKT needs 5.7 GB free for these models and there is 2.0 GB');
    expect(screen.getByRole('button', { name: 'Download models (4.6 GB)' })).toBeDisabled();
    fake.info.enoughDisk = true;
    await user.click(within(alert).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Download models (4.6 GB)' })).toBeEnabled();
    expect(fake.bridge.models.ensure).not.toHaveBeenCalled();
  });

  it('an 8 GB Mac is told it gets the smaller model', async () => {
    installFirstRun({ info: { smallModel: true, totalMemBytes: 8 * GiB } });
    renderApp('/onboarding/4');
    expect(await screen.findByText(/This Mac has 8 GB of memory, so OpenKT uses the smaller understanding model/)).toBeInTheDocument();
  });

  it('everything already on disk: no download is started', async () => {
    const fake = installFirstRun({ rows: rows('ready') });
    renderApp('/onboarding/4');
    expect(await screen.findByText('All set — 4.6 GB on this Mac.')).toBeInTheDocument();
    expect(fake.bridge.models.ensure).not.toHaveBeenCalled();
  });

  it('phase, percent and time left follow the rows', () => {
    const info = { totalBytes: 0, remainingBytes: 0, freeBytes: null, neededBytes: 0, enoughDisk: true, totalMemBytes: 0, smallModel: false, paused: false, bundled: { runtime: true, transcriber: true, textReader: true } };
    const r = rows({ embed: { state: 'ready' }, llm: { state: 'downloading', receivedBytes: 1e9 } }).map((x) => ({ ...x, bytesPerSec: x.state === 'downloading' ? 10e6 : 0 }));
    expect(setupPhase(undefined, info, null)).toBe('checking');
    expect(setupPhase(null, null, null)).toBe('unavailable');
    expect(setupPhase(r, info, null)).toBe('downloading');
    expect(setupPhase(r, { ...info, paused: true }, null)).toBe('paused');
    expect(setupPhase(rows('missing').map((x) => ({ ...x, bytesPerSec: 0 })), { ...info, enoughDisk: false }, null)).toBe('low-disk');
    expect(setupPhase(rows('missing').map((x) => ({ ...x, bytesPerSec: 0 })), info, 'boom')).toBe('error');
    expect(setupPhase(rows('ready').map((x) => ({ ...x, bytesPerSec: 0 })), info, null)).toBe('ready');
    expect(percent(r)).toBe(35);
    expect(etaSeconds(r)).toBe(299);
    expect(formatEta(299)).toBe('about 5 min left');
    expect(formatEta(30)).toBe('less than a minute left');
    expect(formatEta(4000)).toBe('about 1 h 7 min left');
  });
});

describe('step 5 — try it', () => {
  it('"Say something" opens the voice pill and ticks itself only when a voice note is really saved', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ perms: { microphone: 'granted', screen: 'granted', accessibility: 'granted', systemAudio: 'granted' }, rows: rows('ready') });
    const client = renderApp('/onboarding/5');
    const card = await screen.findByRole('listitem', { name: 'Say something' });
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    expect(fake.bridge.app.startCapture).toHaveBeenCalledWith('voice');
    expect(within(card).queryByText('done')).not.toBeInTheDocument();
    // an unrelated session does not count
    await act(() => client.createSession({ source: 'note', title: 'Not a voice note', spaceId: 'sp-personal', text: 'x' }));
    expect(within(card).queryByText('done')).not.toBeInTheDocument();
    // the overlay window files the voice note
    await act(() => client.createSession({ source: 'voice', title: 'Per-store onboarding kit', spaceId: 'sp-personal', text: 'What if every new store…' }));
    expect(await within(card).findByText('done')).toBeInTheDocument();
    expect(within(card).getByText('Saved — “Per-store onboarding kit”')).toBeInTheDocument();
    expect(readProgress()?.tried).toEqual(['voice']);
  });

  it('while speech is downloading the card says how far instead of failing', async () => {
    installFirstRun({ perms: { microphone: 'granted' }, rows: rows({ embed: { state: 'ready' }, llm: { state: 'ready' }, whisper: { state: 'downloading', receivedBytes: 287_020_597 } }) });
    renderApp('/onboarding/5');
    const card = await screen.findByRole('listitem', { name: 'Say something' });
    expect(await within(card).findByText(/^Downloading the speech model — \d+%\.$/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('while something else downloads first, "Finishing setup — N%"', async () => {
    installFirstRun({ perms: { microphone: 'granted' }, rows: rows({ embed: { state: 'ready' }, llm: { state: 'downloading', receivedBytes: 1e9 } }) });
    renderApp('/onboarding/5');
    const card = await screen.findByRole('listitem', { name: 'Say something' });
    expect(await within(card).findByText(/Finishing setup — \d+%/)).toBeInTheDocument();
  });

  it('models put off for later: the card says voice needs the speech model and offers just that', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ perms: { microphone: 'granted' }, ensure: () => new Promise(() => undefined) });
    renderApp('/onboarding/5');
    const card = await screen.findByRole('listitem', { name: 'Say something' });
    expect(await within(card).findByText('Voice needs the speech model (574 MB). It is downloaded once and runs on this Mac.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Download speech model (574 MB)' }));
    expect(fake.bridge.models.ensure).toHaveBeenCalledWith(['whisper']);
  });

  it('"Capture what you see" asks for Screen Recording first when it is off', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ perms: { microphone: 'granted', screen: 'not-determined' }, rows: rows('ready') });
    renderApp('/onboarding/5');
    const card = await screen.findByRole('listitem', { name: 'Capture what you see' });
    expect(await within(card).findByText('Screen Recording is off for OpenKT.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(fake.bridge.permissions.request).toHaveBeenCalledWith('screen');
    act(() => fake.setPerms({ screen: 'granted' }));
    await user.click(await within(card).findByRole('button', { name: 'Capture' }));
    expect(fake.bridge.app.startCapture).toHaveBeenCalledWith('screenshot');
  });

  it('"Write a note" saves a real note right there and ticks itself', async () => {
    const user = userEvent.setup();
    installFirstRun({ perms: { microphone: 'granted', screen: 'granted' }, rows: rows('ready') });
    const client = renderApp('/onboarding/5');
    const card = await screen.findByRole('listitem', { name: 'Write a note' });
    await user.click(within(card).getByRole('button', { name: 'Write' }));
    await user.type(within(card).getByLabelText('Note'), 'Call with Ana — revised deck by Friday.');
    await user.click(within(card).getByRole('button', { name: 'Save note' }));
    expect(await within(card).findByText('done')).toBeInTheDocument();
    const mine = await client.listSessions({ mine: true });
    expect(mine[0]).toMatchObject({ source: 'note' });
    expect(screen.getByText('1 of 3 tried. The menu bar has all of these any time.')).toBeInTheDocument();
  });

  it('"Open OpenKT" finishes: onboarding is done on this Mac and the progress record is gone', async () => {
    const user = userEvent.setup();
    installFirstRun({ rows: rows('ready') });
    renderApp('/onboarding/5');
    await user.click(await screen.findByRole('button', { name: 'Open OpenKT' }));
    expect(await screen.findByRole('navigation', { name: 'Sessions' })).toBeInTheDocument();
    expect(localStorage.getItem('openkt.onboarded')).toBe('1');
    expect(readProgress()).toBeNull();
  });
});

describe('the rest of the app while it downloads', () => {
  it('the sidebar footer shows how far the download is, and links to Settings → Models', async () => {
    const fake = installFirstRun({ rows: rows({ embed: { state: 'ready' }, llm: { state: 'downloading', receivedBytes: 1e9 } }) });
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/new');
    const link = await screen.findByRole('link', { name: /Setting up on-device AI, \d+%/ });
    expect(link).toHaveAttribute('href', '/settings/models');
    act(() => fake.progress({ role: 'llm', state: 'error', error: 'fetch failed' }));
    expect(await screen.findByRole('link', { name: /On-device AI download stopped/ })).toBeInTheDocument();
  });

  it('no indicator once everything is on this Mac', async () => {
    installFirstRun({ rows: rows('ready') });
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/new');
    await screen.findByRole('navigation', { name: 'Sessions' });
    await waitFor(() => expect(screen.queryByRole('link', { name: /on-device AI/i })).not.toBeInTheDocument());
  });

  it('the voice pill says "Finishing setup" instead of recording when speech is not on this Mac yet', async () => {
    const fake = installFirstRun({ rows: rows({ embed: { state: 'ready' }, llm: { state: 'ready' }, whisper: { state: 'downloading', receivedBytes: 100e6 } }) });
    const voice = { begin: async () => 'v1', end: async () => ({}), cancel: () => undefined, chunk: () => undefined };
    Object.assign(fake.bridge, { voice });
    render(
      <ApiProvider client={new MockClient()}>
        <VoiceCapture onClose={() => undefined} recorder={async () => ({ stop: async () => undefined, cancel: () => undefined })} lingerMs={0} />
      </ApiProvider>,
    );
    expect(await screen.findByText(/Finishing setup — \d+%\. Voice notes work as soon as the speech model is on this Mac\./)).toBeInTheDocument();
    expect(screen.getByText('speech not on this Mac yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('Settings → Permissions: the same rows, live, with a reminder chip in the nav', async () => {
    installFirstRun({ perms: { microphone: 'granted', screen: 'denied', accessibility: 'not-determined' } });
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/settings/permissions');
    expect(await screen.findByRole('heading', { level: 1, name: 'Permissions' })).toBeInTheDocument();
    expect(await screen.findByLabelText('2 still off')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open System Settings: Screen Recording' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow: Accessibility' })).toBeInTheDocument();
  });

  it('Settings → Models uses the live download, not sample rows', async () => {
    installFirstRun({ rows: rows({ embed: { state: 'ready' } }) });
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/settings/models');
    expect(await screen.findByRole('list', { name: 'Models on this Mac' })).toBeInTheDocument();
    expect(screen.queryByText('Qwen3-Reranker-0.6B')).not.toBeInTheDocument();
    expect(screen.queryByText('Use my own endpoint')).not.toBeInTheDocument();
    expect(screen.getByText('4.0 GB left of 4.6 GB, downloaded once.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download models (4.0 GB)' })).toBeInTheDocument();
  });

  it('the voice pill, with the speech model not on this Mac: says so and offers just the speech model', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ rows: rows({ embed: { state: 'ready' }, llm: { state: 'ready' } }) });
    const voice = { begin: vi.fn(async () => 'v1'), end: async () => ({}), cancel: () => undefined, chunk: () => undefined };
    Object.assign(fake.bridge, { voice });
    render(
      <ApiProvider client={new MockClient()}>
        <VoiceCapture onClose={() => undefined} recorder={async () => ({ stop: async () => undefined, cancel: () => undefined })} lingerMs={0} />
      </ApiProvider>,
    );
    expect(await screen.findByText(/Voice needs the speech model \(574 MB\)\. It is downloaded once and runs on this Mac — nothing is sent to a cloud model\./)).toBeInTheDocument();
    expect(voice.begin).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Download the speech model (574 MB)' }));
    expect(fake.bridge.models.ensure).toHaveBeenCalledWith(['whisper']);
    expect(await screen.findByText('The speech model is on this Mac. Press ⌃⌥Space to talk.')).toBeInTheDocument();
  });

  it('New note, with the on-device AI not on this Mac: one line saying why, and the download right there', async () => {
    const user = userEvent.setup();
    const fake = installFirstRun({ ensure: () => new Promise(() => undefined) });
    localStorage.setItem('openkt.onboarded', '1');
    renderApp('/new');
    const note = await screen.findByText(/Pulling out the key points needs the on-device AI/);
    await user.click(within(note.closest('p')!).getByRole('button', { name: 'Download (4.6 GB)' }));
    expect(fake.bridge.models.ensure).toHaveBeenCalledWith(undefined);
  });
});

