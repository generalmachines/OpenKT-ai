/**
 * The voice pill and the screenshot sheet, driven by a FAKE capture IPC
 * (window.openkt.voice / .screenshot / .models / .localAi) and a fake
 * recorder. No microphone, whisper or screen is involved: this proves the
 * renderer's half of the contract, on the mock adapter.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/hooks';
import { MockClient } from '../../src/api/mock';
import { RecorderError, type Recorder, type RecorderOptions } from '../../src/capture/recorder';
import { drainPending, readPending } from '../../src/capture/save';
import { ScreenshotCapture, screenshotTurns } from '../../src/screens/capture/ScreenshotCapture';
import { EXTRACT_LATER, VoiceCapture } from '../../src/screens/capture/VoiceCapture';

const NOTE = {
  status: 'ok',
  title: 'Per-store onboarding kit',
  summary: 'An onboarding kit for every new store.',
  facts: [
    { kind: 'idea', statement: 'Give every new store a printed shelf map', quote: 'printed shelf map' },
    { kind: 'action', statement: 'Draft the first-week planogram template', quote: 'first week' },
  ],
};
const TRANSCRIPT = 'What if every new store got an onboarding kit, a printed shelf map and the first week planogram.';

interface Fake {
  voice: { begin: ReturnType<typeof vi.fn>; chunk: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; toSession: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  screenshot: { capture: ReturnType<typeof vi.fn> };
  models: { status: ReturnType<typeof vi.fn>; ensure: ReturnType<typeof vi.fn>; onProgress: ReturnType<typeof vi.fn> };
  localAi: { extractNote: ReturnType<typeof vi.fn> };
}

let fake: Fake;
const modelRows = (state: string) => ({ models: [{ role: 'llm', id: 'qwen3.5-4b', file: 'q.gguf', path: '', totalBytes: 100, receivedBytes: state === 'ready' ? 100 : 40, state }] });

beforeEach(() => {
  localStorage.clear();
  fake = {
    voice: {
      begin: vi.fn(async () => 'v1'),
      chunk: vi.fn(),
      end: vi.fn(async () => ({ text: TRANSCRIPT, segments: [], language: 'en', duration_ms: 14_000 })),
      toSession: vi.fn(async () => NOTE),
      cancel: vi.fn(),
    },
    screenshot: { capture: vi.fn() },
    models: { status: vi.fn(async () => modelRows('ready')), ensure: vi.fn(), onProgress: vi.fn(() => () => undefined) },
    localAi: { extractNote: vi.fn(async () => NOTE) },
  };
  (window as unknown as { openkt: unknown }).openkt = fake;
});

afterEach(() => {
  delete (window as unknown as { openkt?: unknown }).openkt;
});

/** A recorder the test drives by hand. */
function fakeRecorder() {
  const rec: Recorder & { opts?: RecorderOptions } = { stop: vi.fn(async () => undefined), cancel: vi.fn() };
  const start = vi.fn(async (opts: RecorderOptions) => {
    rec.opts = opts;
    return rec;
  });
  return { rec, start };
}

function mountVoice(client = new MockClient(), recorder = fakeRecorder()) {
  const onClose = vi.fn();
  let toggle = () => undefined as void;
  render(
    <ApiProvider client={client}>
      <VoiceCapture
        onClose={onClose}
        recorder={recorder.start}
        lingerMs={0}
        onToggle={(l) => {
          toggle = l;
          return () => undefined;
        }}
      />
    </ApiProvider>,
  );
  return { client, onClose, recorder, toggle: () => act(() => toggle()) };
}

const voiceSessions = async (c: MockClient) => (await c.listSessions({ mine: true })).filter((s) => s.id.includes('-new-'));

describe('voice pill', () => {
  it('happy path: streams PCM, transcribes on release, saves a closed voice session with its facts to the personal space', async () => {
    const user = userEvent.setup();
    const { client, onClose, recorder, toggle } = mountVoice();
    expect(await screen.findByText(/^listening · 0:00 · on this Mac$/)).toBeInTheDocument();
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());

    const pcm = new Int16Array(4000).buffer;
    act(() => {
      recorder.rec.opts!.onLevel(0.7);
      recorder.rec.opts!.onChunk(pcm);
    });
    expect(fake.voice.chunk).toHaveBeenCalledWith('v1', pcm);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    toggle();
    expect(await screen.findByText(TRANSCRIPT)).toBeInTheDocument();
    expect(recorder.rec.stop).toHaveBeenCalled();
    expect(fake.voice.end).toHaveBeenCalledWith('v1', { language: 'auto' });
    expect(screen.getByText(/^transcribed · 0:14 · on this Mac$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save to/ })).toHaveTextContent(/personal/i);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const [s] = await voiceSessions(client);
    expect(s).toMatchObject({ source: 'voice', status: 'closed', title: NOTE.title, summary: NOTE.summary, spaceId: 'sp-personal' });
    expect((await client.getSession(s!.id)).turns.map((t) => t.text)).toEqual([TRANSCRIPT]);
    expect((await client.listContext(s!.id)).map((c) => [c.kind, c.statement])).toEqual(NOTE.facts.map((f) => [f.kind, f.statement]));
    expect(readPending()).toEqual([]);
  });

  it('an empty clip saves nothing and says so', async () => {
    fake.voice.end.mockResolvedValue({ empty: true });
    const { client, onClose, toggle, recorder } = mountVoice();
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
    toggle();
    expect(await screen.findByText('Nothing was said, so nothing was saved.')).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await voiceSessions(client)).toEqual([]);
  });

  it('microphone denied: a plain instruction, no session, esc closes', async () => {
    const user = userEvent.setup();
    const recorder = fakeRecorder();
    recorder.start.mockRejectedValue(new RecorderError('permission', 'Permission denied'));
    const { client, onClose } = mountVoice(new MockClient(), recorder);
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot use the microphone.*System Settings → Privacy & Security → Microphone/);
    expect(screen.getByText('microphone blocked')).toBeInTheDocument();
    expect(fake.voice.cancel).toHaveBeenCalledWith('v1');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(await voiceSessions(client)).toEqual([]);
  });

  it('a permission error from the main process reads the same way', async () => {
    fake.voice.begin.mockRejectedValue(new Error("Error invoking remote method 'voice:begin': permission"));
    mountVoice();
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot use the microphone/);
  });

  it('esc while listening discards: recorder cancelled, nothing transcribed or saved', async () => {
    const user = userEvent.setup();
    const { client, onClose, recorder } = mountVoice();
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
    await user.keyboard('{Escape}');
    expect(recorder.rec.cancel).toHaveBeenCalled();
    expect(fake.voice.cancel).toHaveBeenCalledWith('v1');
    expect(fake.voice.end).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(await voiceSessions(client)).toEqual([]);
  });

  it('models not downloaded yet: saves without facts, says why, and files the facts once the models are ready', async () => {
    const user = userEvent.setup();
    fake.models.status.mockResolvedValue(modelRows('downloading'));
    const { client, onClose, toggle, recorder } = mountVoice();
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
    toggle();
    await screen.findByText(TRANSCRIPT);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(EXTRACT_LATER)).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const [s] = await voiceSessions(client);
    expect(s).toMatchObject({ source: 'voice', status: 'closed' });
    expect(fake.voice.toSession).not.toHaveBeenCalled();
    expect(await client.listContext(s!.id)).toEqual([]);
    expect(readPending()).toEqual([{ sessionId: s!.id, spaceId: 'sp-personal', text: TRANSCRIPT }]);

    expect(await drainPending(client)).toBe(0); // still downloading: nothing happens
    fake.models.status.mockResolvedValue(modelRows('ready'));
    expect(await drainPending(client)).toBe(1);
    expect(fake.localAi.extractNote).toHaveBeenCalledWith({ text: TRANSCRIPT, source: 'note' });
    expect((await client.listContext(s!.id)).map((c) => c.statement)).toEqual(NOTE.facts.map((f) => f.statement));
    expect(readPending()).toEqual([]);
  });
});

const SHOT = {
  image_path: '/tmp/openkt/shot-1.png',
  title: 'Competitor pricing page',
  description: 'Competitor pricing page — three tiers, per-store billing on the top tier.',
  visible_text: 'Starter $49 · Growth $149 · Enterprise per store',
  entities: ['Enterprise', '$149'],
  facts: [{ kind: 'fact', statement: 'The competitor bills per store on its top tier', quote: 'per-store billing on the top tier' }],
};

function mountShot(request: Parameters<typeof ScreenshotCapture>[0]['request'] = { mode: 'interactive' }, client = new MockClient()) {
  const onClose = vi.fn();
  render(
    <ApiProvider client={client}>
      <ScreenshotCapture request={request} onClose={onClose} lingerMs={0} />
    </ApiProvider>,
  );
  return { client, onClose };
}

describe('screenshot sheet', () => {
  it('happy path: description as the title line, Save files description + text-in-image turns and the facts', async () => {
    const user = userEvent.setup();
    fake.screenshot.capture.mockResolvedValue(SHOT);
    const { client, onClose } = mountShot();
    expect(screen.getByText('Reading what is on screen…')).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue(SHOT.title);
    expect(fake.screenshot.capture).toHaveBeenCalledWith({ mode: 'interactive' });
    expect(document.querySelector('img.thumb')).toHaveAttribute('src', 'file:///tmp/openkt/shot-1.png');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [s] = await voiceSessions(client);
    expect(s).toMatchObject({ source: 'screenshot', status: 'closed', title: SHOT.title, summary: SHOT.description, spaceId: 'sp-personal' });
    expect((await client.getSession(s!.id)).turns.map((t) => t.text)).toEqual([SHOT.description, `Text in image: ${SHOT.visible_text}`]);
    expect((await client.listContext(s!.id)).map((c) => c.statement)).toEqual([SHOT.facts[0]!.statement]);
  });

  it('a typed title becomes the caption turn, first (Spec 03 §4)', async () => {
    const user = userEvent.setup();
    fake.screenshot.capture.mockResolvedValue(SHOT);
    const { client, onClose } = mountShot();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Rival pricing, for the Northgate deck');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [s] = await voiceSessions(client);
    expect((await client.getSession(s!.id)).turns.map((t) => t.text)).toEqual(['Rival pricing, for the Northgate deck', SHOT.description, `Text in image: ${SHOT.visible_text}`]);
    expect(screenshotTurns({ description: 'd', visibleText: '' }, '')).toEqual(['d']);
  });

  it('cancelled in the picker: closes silently, saves nothing', async () => {
    fake.screenshot.capture.mockResolvedValue({ cancelled: true });
    const { client, onClose } = mountShot();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await voiceSessions(client)).toEqual([]);
  });

  it('nothing worth saving: says so plainly and offers only Close', async () => {
    const user = userEvent.setup();
    fake.screenshot.capture.mockResolvedValue({ image_path: '/tmp/x.png', title: '', description: '', visible_text: 'ok', entities: [], facts: [] });
    const { client, onClose } = mountShot();
    expect(await screen.findByText(/Nothing worth saving here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await voiceSessions(client)).toEqual([]);
  });

  it('a dropped image file is read by path', async () => {
    fake.screenshot.capture.mockResolvedValue(SHOT);
    mountShot({ mode: 'file', path: '/Users/p/Desktop/chart.png' });
    await screen.findByRole('textbox', { name: 'Title' });
    expect(fake.screenshot.capture).toHaveBeenCalledWith({ mode: 'file', path: '/Users/p/Desktop/chart.png' });
  });

  it('screen recording denied: says where to allow it', async () => {
    fake.screenshot.capture.mockRejectedValue(new Error('screen recording permission denied'));
    mountShot();
    expect(await screen.findByText(/cannot record the screen.*Screen Recording/)).toBeInTheDocument();
  });

  it('models not ready and no facts yet: saved, queued, and the sheet says why', async () => {
    const user = userEvent.setup();
    fake.screenshot.capture.mockResolvedValue({ ...SHOT, facts: [] });
    fake.models.status.mockResolvedValue(modelRows('missing'));
    const { client } = mountShot();
    await screen.findByRole('textbox', { name: 'Title' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(EXTRACT_LATER)).toBeInTheDocument();
    const [s] = await voiceSessions(client);
    expect(readPending().map((p) => p.sessionId)).toEqual([s!.id]);
  });
});
