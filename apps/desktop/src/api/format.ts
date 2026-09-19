import type { ContextKind, Grant, SessionListItem, SessionSource, Space } from './types';

export const SOURCE_LABEL: Record<SessionSource, string> = {
  meeting: 'meeting',
  'claude-code': 'claude code',
  cursor: 'cursor',
  chatgpt: 'chatgpt',
  claude: 'claude',
  hermes: 'hermes',
  voice: 'voice',
  screenshot: 'screenshot',
  note: 'note',
  codex: 'codex',
  connector: 'import',
};

export function sourceLabel(s: SessionSource): string {
  return SOURCE_LABEL[s];
}

/** "cowork" for a Claude session that came through Cowork, "notion" for a Notion import; otherwise the source. */
export function viaLabel(s: { source: SessionSource; via?: string }): string {
  return s.via ? s.via.toLowerCase() : sourceLabel(s.source);
}

/** Colours per kind, from design/gen.py `KC`. `issue` is not in the mocks. */
export const KIND_COLOR: Record<ContextKind, string> = {
  decision: '#b4532a',
  action: '#4f7a4a',
  fact: '#4f6471',
  question: '#9b771a',
  idea: '#7a5a8c',
  'how-to': '#55544f',
  issue: '#8f3f1e',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function daysAgo(iso: string, now: Date = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
}

/** "today" · "yesterday" · "11 Sep" */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const n = daysAgo(iso, now);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "today 10:02" */
export function relativeDayTime(iso: string, now: Date = new Date()): string {
  return `${relativeDay(iso, now)} ${clock(iso)}`;
}

export function duration(sec: number): string {
  if (sec < 60) return `${sec} sec`;
  return `${Math.round(sec / 60)} min`;
}

/** "12:41" style offset for transcript rows and the recording pill. */
export function offset(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Sidebar meta line: "meeting · 42 min", "claude code · openkt". */
export function sessionListMeta(s: SessionListItem, space: Space | undefined): string {
  const tail = s.source === 'meeting' && s.durationSec ? duration(s.durationSec) : (space?.slug ?? '');
  return tail ? `${viaLabel(s)} · ${tail}` : viaLabel(s);
}

/** Header lock line: "sales team can read" · "only you". */
export function accessSummary(grants: Grant[]): string {
  const team = grants.find((g) => g.subject.type === 'team');
  if (team) {
    const verb = team.role === 'reader' ? 'read' : team.role === 'editor' ? 'edit' : 'manage';
    return `${team.subject.name.toLowerCase()} can ${verb}`;
  }
  const others = grants.filter((g) => g.role !== 'owner').length;
  if (others > 0) return `you and ${others} ${others === 1 ? 'person' : 'people'}`;
  return 'only you';
}

export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** "today" · "yesterday" · "2 days ago" · "3 weeks ago" · "4 months ago" — for version history. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const n = daysAgo(iso, now);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 14) return `${n} days ago`;
  if (n < 63) return `${Math.round(n / 7)} weeks ago`;
  if (n < 365) return `${Math.round(n / 30)} months ago`;
  const years = Math.round(n / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** "used 31 times this month" */
export function usedThisMonth(count: number): string {
  if (count <= 0) return 'not used yet this month';
  if (count === 1) return 'used once this month';
  return `used ${count} times this month`;
}

/** "Dr. Ekwueme" → "DE", "Sam Okoro" → "SO", "Dana" → "DA", "server-agent" → "SA". */
export function initialsOf(name: string): string {
  const words = name.replace(/\./g, '').split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}
