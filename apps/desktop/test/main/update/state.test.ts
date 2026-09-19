import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, MAX_UNHEALTHY_STARTS, markHealthy, markRolledBack, onLaunch, readState, writeState, type UpdaterState } from '../../../src/main/update/state';

const exists = { exists: () => true };
const gone = { exists: () => false };
const pendingState = (starts = 0): UpdaterState => ({
  ...DEFAULT_STATE,
  pending: { version: '0.3.9', from: '0.3.8', oldAppPath: '/Applications/OpenKT.app.old-1', installedAt: '2026-09-19T10:00:00Z', starts },
  pendingNotes: ['Faster search'],
});

describe('pending-verify state machine', () => {
  it('is a normal launch without a marker', () => {
    expect(onLaunch(DEFAULT_STATE, '0.3.8', exists).outcome).toEqual({ kind: 'normal' });
  });

  it('counts starts of the new version until it is healthy, then shows "what\'s new" once', () => {
    let s = pendingState();
    const first = onLaunch(s, '0.3.9', exists);
    expect(first.outcome).toMatchObject({ kind: 'verifying', starts: 1 });
    s = markHealthy(first.state, new Date('2026-09-19T10:01:00Z'));
    expect(s.pending).toBeNull();
    expect(s.lastUpdate).toEqual({ version: '0.3.9', from: '0.3.8', notes: ['Faster search'], at: '2026-09-19T10:01:00.000Z', seen: false });
    expect(onLaunch(s, '0.3.9', exists).outcome.kind).toBe('normal');
  });

  it('offers "Go back" when two starts never became healthy and the old copy is still there', () => {
    let s = pendingState();
    for (let i = 1; i <= MAX_UNHEALTHY_STARTS; i += 1) {
      const r = onLaunch(s, '0.3.9', exists);
      expect(r.outcome).toMatchObject({ kind: 'verifying', starts: i });
      s = r.state; // crashed before markHealthy
    }
    expect(onLaunch(s, '0.3.9', exists).outcome.kind).toBe('offer-rollback');
    // No previous copy on disk: nothing to go back to, keep verifying.
    expect(onLaunch(s, '0.3.9', gone).outcome.kind).toBe('verifying');
  });

  it('going back blocks the broken version', () => {
    const s = markRolledBack(pendingState(2));
    expect(s.pending).toBeNull();
    expect(s.blocked).toEqual(['0.3.9']);
    expect(markRolledBack({ ...pendingState(2), blocked: ['0.3.9'] }).blocked).toEqual(['0.3.9']);
  });

  it('a marker for another version means the swap did not happen', () => {
    const r = onLaunch(pendingState(), '0.3.8', exists);
    expect(r.outcome.kind).toBe('swap-failed');
    expect(r.state.pending).toBeNull();
  });

  it('persists atomically and survives garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkt-upd-state-'));
    try {
      const p = join(dir, 'updates', 'state.json');
      expect(readState(p)).toEqual(DEFAULT_STATE);
      writeState(p, { ...pendingState(1), auto: false });
      expect(readState(p)).toMatchObject({ auto: false, pending: { version: '0.3.9', starts: 1 } });
      writeFileSync(p, '{"auto": "no", "pending": {"version": 7}, "blocked": [1, "0.3.2"]}');
      expect(readState(p)).toMatchObject({ auto: true, pending: null, blocked: ['0.3.2'] });
      writeFileSync(p, 'not json');
      expect(readState(p).auto).toBe(true);
      expect(readFileSync(p, 'utf8')).toBe('not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
