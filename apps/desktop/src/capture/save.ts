/**
 * Filing a capture: the same four beats as a typed note — session, turns,
 * facts, close — for voice notes and screenshots, on either adapter.
 *
 * When this Mac's models are still downloading there are no facts yet. The
 * session is saved anyway and its text is queued; `drainPending` extracts
 * and files the facts once `models.status` says everything is ready.
 */
import type { ExtractedFact, ExtractedNote } from '../api/bridge';
import { localAi, models } from '../api/bridge';
import type { OpenKTClient } from '../api/client';
import { modelsSetup } from '../api/setup-bridge';
import type { ContextKind, Id, NewFactInput, Session, SessionSource } from '../api/types';

const KINDS: readonly ContextKind[] = ['decision', 'action', 'fact', 'question', 'how-to', 'idea', 'issue'];
export const asKind = (k: string): ContextKind => KINDS.find((x) => x === k) ?? 'fact';

export interface CaptureToFile {
  source: Extract<SessionSource, 'voice' | 'screenshot' | 'note'>;
  title: string;
  spaceId: Id;
  turns: string[];
  summary?: string;
  facts: ExtractedFact[];
  /** True when extraction could not run yet; the text is queued for later. */
  extractLater?: boolean;
}

/** The server keeps up to 20 000 characters per fact. */
const FACT_MAX = 20_000;

/**
 * What was typed or said, as one fact: its title, then its words. Saved whenever nothing was
 * extracted (no on-device AI, still downloading, or it found nothing), so it can always be
 * recalled — by ⌘K, by a teammate it is shared with, by every connected tool.
 */
export function asWritten(sessionId: Id, spaceId: Id, title: string, text: string): NewFactInput {
  const body = text.trim();
  const head = title.trim();
  const statement = head && !body.startsWith(head) ? `${head}\n\n${body}` : body || head;
  return { sessionId, spaceId, kind: 'fact', statement: statement.length > FACT_MAX ? `${statement.slice(0, FACT_MAX - 1)}…` : statement };
}

/**
 * True when extracting on this Mac can work right now: the IPC exists, every model is on disk and the
 * runtime ships in this build. Otherwise asking would only make the person wait for a failure.
 */
export async function localAiReady(): Promise<boolean> {
  if (!localAi.available() || (await modelsPending())) return false;
  const info = await modelsSetup.setupInfo();
  return info === null || info.bundled.runtime;
}

export async function fileCapture(client: OpenKTClient, c: CaptureToFile): Promise<Session> {
  const turns = c.turns.map((t) => t.trim()).filter(Boolean);
  const firstLine = (turns[0] ?? '').split('\n')[0]!.slice(0, 60);
  const title = c.title.trim() || firstLine || 'Untitled';
  const session = await client.createSession({ source: c.source, title, spaceId: c.spaceId, turns, extractedOn: c.facts.length ? 'device' : 'none' });
  for (const f of c.facts) await client.saveFact({ sessionId: session.id, spaceId: c.spaceId, statement: f.statement, kind: asKind(f.kind) });
  // Nothing extracted: the words themselves are the context. A refusal (a near-duplicate) keeps the session.
  if (!c.facts.length && turns.length) await client.saveFact(asWritten(session.id, c.spaceId, c.title, turns.join('\n'))).catch(() => undefined);
  const closed = await client.closeSession(session.id, c.summary?.trim() || turns.join('\n').slice(0, 600));
  if (c.extractLater) enqueuePending({ sessionId: session.id, spaceId: c.spaceId, text: turns.join('\n') });
  announceCapture();
  return closed;
}

/** Overlays are separate windows with their own client; a `storage` event is how the main window hears about a new session. */
export const CAPTURE_SIGNAL = 'openkt.last-capture';
function announceCapture(): void {
  try {
    globalThis.localStorage?.setItem(CAPTURE_SIGNAL, String(Date.now()));
  } catch {
    /* the sidebar catches up on its next read */
  }
}

/** True when the model IPC exists and at least one model is not on disk yet. Unknown (no IPC) counts as ready. */
export async function modelsPending(): Promise<boolean> {
  const status = await models.status();
  return status !== null && status.some((m) => m.state !== 'ready');
}

// ── pending extractions ─────────────────────────────────────────────────

export interface PendingExtraction {
  sessionId: Id;
  spaceId: Id;
  text: string;
}

const KEY = 'openkt.pending-extractions';

export function readPending(): PendingExtraction[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as PendingExtraction[]).filter((p) => p && typeof p.sessionId === 'string' && typeof p.text === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingExtraction[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list.slice(-50)));
  } catch {
    /* nothing to persist to */
  }
}

export function enqueuePending(p: PendingExtraction): void {
  writePending([...readPending().filter((x) => x.sessionId !== p.sessionId), p]);
}

let draining = false;

/**
 * Extract and file facts for queued sessions. Does nothing until local AI is
 * present and every model is ready. Returns how many sessions were finished.
 * An item leaves the queue only after its facts are saved (or there were none).
 */
export async function drainPending(client: OpenKTClient, extract: (text: string) => Promise<ExtractedNote | null> = (t) => localAi.extractNote(t)): Promise<number> {
  if (draining || !readPending().length || !localAi.available() || (await modelsPending())) return 0;
  draining = true;
  let done = 0;
  try {
    for (const item of readPending()) {
      const note = await extract(item.text);
      if (!note) break; // local AI not answering yet: try again on the next tick
      for (const f of note.facts) await client.saveFact({ sessionId: item.sessionId, spaceId: item.spaceId, statement: f.statement, kind: asKind(f.kind) });
      // The extracted facts take over from the words saved as written, so recall does not answer twice.
      if (note.facts.length) {
        const words = item.text.trim();
        for (const c of await client.listContext(item.sessionId)) if (c.statement === words || c.statement.endsWith(`\n\n${words}`)) await client.deleteFact(c.id);
      }
      writePending(readPending().filter((x) => x.sessionId !== item.sessionId));
      done += 1;
    }
  } catch {
    /* offline or signed out: the queue keeps the rest */
  } finally {
    draining = false;
  }
  return done;
}
