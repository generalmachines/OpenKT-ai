/**
 * The job protocol between this Mac and the OpenKT server (server: modules/jobs/contracts/job.contract.ts).
 *
 *   POST /v1/jobs/claim           {kinds?, worker?}            → {job, input} | {job: null}
 *   POST /v1/jobs/:id/lookup      {facts:[{id, statement}]}    → nearest facts + candidate pages (extends the lease)
 *   POST /v1/jobs/:id/complete    {result}                     → what the server applied
 *   POST /v1/jobs/:id/fail        {error, retry?}              → queued again with back-off, or failed
 *
 * The Mac does the model work; the server stores, shares and re-validates everything it is sent.
 * Only text goes up: never audio, never images.
 */

export type JobKind = 'process_session' | 'refresh_brief';
export type Kind = 'decision' | 'fact' | 'how-to' | 'issue' | 'question' | 'action' | 'idea';

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  project_id: string;
  session_id: string | null;
  attempts: number;
  lease_until: string;
}

export interface SessionJobInput {
  space: { id: string; name: string };
  session: {
    id: string;
    title: string | null;
    summary: string | null;
    source: string;
    started_at: string;
    ended_at: string | null;
    author: { id: string; name: string };
  };
  turns: { seq: number; role: string; content: string }[];
  vocabulary: { tag: string; count: number }[];
  /** Facts saved during the session (kt_save_memory): routed to pages with the extracted ones. */
  session_facts: { id: string; statement: string; kind: Kind; author: string; created_at: string }[];
  /** Earlier facts of the space no page cites yet: routed again with this session's (Spec 02 §5). */
  unrouted_facts?: { id: string; statement: string; kind: Kind; author: string; created_at: string }[];
  limits: { section_max_chars: number; page_max_sections: number; brief_max_chars: number };
}

export interface BriefJobInput {
  space: { id: string; name: string };
  pages: { title: string; summary: string; updated_at: string }[];
  recent_changes: { date: string; page_title: string; change: string }[];
  previous_brief: string | null;
  source_hash: string;
  max_chars: number;
}

export type Claim =
  | { job: null }
  | { job: ClaimedJob & { kind: 'process_session' }; input: SessionJobInput }
  | { job: ClaimedJob & { kind: 'refresh_brief' }; input: BriefJobInput };

export interface LookupNeighbour {
  id: string;
  project_id: string;
  statement: string;
  kind: Kind;
  created_at: string;
  owner_user_id: string;
  is_pinned: boolean;
  confidence: number;
  similarity: number;
}

export interface LookupSection {
  id: string;
  heading: string;
  body_md: string;
  locked: boolean;
  fact_ids: string[];
}

export interface LookupPage {
  id: string;
  title: string;
  summary: string;
  score: number;
  sections: LookupSection[];
}

export interface LookupResult {
  lease_until: string;
  embedding: 'ok' | 'unavailable';
  neighbours: Record<string, LookupNeighbour[]>;
  pages: LookupPage[];
}

export interface ResultFact {
  /** A v4 uuid chosen here, so sections can cite the fact before the server saves it. */
  id: string;
  statement: string;
  quote: string;
  kind: Kind;
  tags: string[];
  duplicate_of: string | null;
  supersedes: string[];
}

export interface ResultSection {
  page_id: string | null;
  new_page_title: string | null;
  section_id: string | null;
  heading: string;
  body_md: string;
  mode: 'append' | 'rewrite_section' | 'fallback';
}

export interface SessionResult {
  summary: { title: string; summary: string; open_questions: string[] } | null;
  facts: ResultFact[];
  sections: ResultSection[];
  unrouted: { id: string; reason: string }[];
  stats: Record<string, unknown>;
}

export interface BriefResult {
  brief_md: string;
  source_hash: string;
  stats: Record<string, unknown>;
}

export interface ApplyReport {
  facts?: { saved: number; duplicates: number; superseded: number; dropped: Record<string, number> };
  sections?: { written: number; fallback: number; refused: Record<string, number> };
  pages?: { created: number; changed: string[] };
  written?: boolean;
  [key: string]: unknown;
}

/** What the worker needs from the server. `ServerError.status` 401 means signed out. */
export interface JobsServer {
  claim(kinds: JobKind[], worker: string): Promise<Claim>;
  lookup(jobId: string, facts: { id: string; statement: string }[]): Promise<LookupResult>;
  complete(jobId: string, result: SessionResult | BriefResult): Promise<{ applied: ApplyReport }>;
  fail(jobId: string, error: string, retry: boolean): Promise<void>;
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

/** The server over HTTP, with the member's own access token (read fresh for every request). */
export class HttpJobsServer implements JobsServer {
  constructor(
    private readonly baseUrl: () => string,
    private readonly token: () => Promise<string | null>,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.token();
    if (!token) throw new ServerError('signed out', 401, 'signed_out');
    const res = await this.fetchImpl(`${this.baseUrl().replace(/\/+$/, '')}/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: { data?: unknown; error?: { code?: string; message?: string } } = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      /* not JSON: reported below by status */
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ServerError(parsed.error?.message ?? `The server answered ${res.status}.`, res.status, parsed.error?.code ?? '');
    }
    return parsed.data as T;
  }

  claim(kinds: JobKind[], worker: string): Promise<Claim> {
    return this.post('/jobs/claim', { kinds, worker });
  }

  lookup(jobId: string, facts: { id: string; statement: string }[]): Promise<LookupResult> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/lookup`, { facts });
  }

  complete(jobId: string, result: SessionResult | BriefResult): Promise<{ applied: ApplyReport }> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/complete`, { result });
  }

  async fail(jobId: string, error: string, retry: boolean): Promise<void> {
    await this.post(`/jobs/${encodeURIComponent(jobId)}/fail`, { error: error.slice(0, 2000), retry });
  }
}
