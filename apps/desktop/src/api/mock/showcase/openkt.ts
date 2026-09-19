/**
 * OpenKT — the team building this product.
 * Every statement, page summary, fork, change and relation below is copied from the
 * OpenKT knowledge-synthesis report (https://dwlabs.org/work/openkt-kb). Session titles,
 * sources and times are sample glue. Keep the statements verbatim when editing.
 */
import type { ShowcaseTeam } from './types';

export const openkt: ShowcaseTeam = {
  space: { id: 'sp-openkt', name: 'openkt', label: 'OpenKT', description: 'The team building this product.', myRole: 'owner', owner: 'me', team: ['t-openkt', 'OpenKT'] },
  stats: { memories: 30, people: 3, pages: 7 },
  people: [
    { key: 'me', name: 'Pratham', title: 'founder' },
    { key: 'claude', name: 'Claude', title: 'AI engineer' },
    { key: 'server-agent', name: 'server-agent', title: 'gastown rig' },
  ],
  sessions: [
    { id: 's-openkt-recall', source: 'claude-code', title: 'Recall: one layer or two', by: 'me', day: 0, time: '09:12', facts: ['f-openkt-18', 'f-openkt-19', 'f-openkt-10', 'f-openkt-11', 'f-openkt-9', 'f-openkt-8'], question: 'Recall return format: single vs dual layer' },
    { id: 's-openkt-one-postgres', source: 'claude-code', title: 'Collapse MemMachine and OpenKT onto one Postgres', by: 'me', day: 6, time: '14:20', facts: ['f-openkt-3', 'f-openkt-4', 'f-openkt-5', 'f-openkt-6', 'f-openkt-26'] },
    { id: 's-openkt-titan', source: 'claude-code', title: 'Retire BGE: one Titan module', by: 'me', day: 12, time: '11:05', facts: ['f-openkt-0', 'f-openkt-1', 'f-openkt-2', 'f-openkt-27'] },
    { id: 's-openkt-kb-synthesis', source: 'claude', via: 'Cowork', title: 'Knowledge bases without a cosine gate', by: 'me', day: 1, time: '16:40', facts: ['f-openkt-13', 'f-openkt-14', 'f-openkt-15', 'f-openkt-16', 'f-openkt-17', 'f-openkt-12'] },
    { id: 's-openkt-shakeout', source: 'codex', title: 'Pipeline shakeout on docker-compose', by: 'me', day: 4, time: '10:30', facts: ['f-openkt-24', 'f-openkt-25', 'f-openkt-29', 'f-openkt-7'] },
    { id: 's-openkt-auth', source: 'cursor', title: 'Auth: one dispatcher, one ActorContext', by: 'me', day: 3, time: '15:10', facts: ['f-openkt-20', 'f-openkt-21'], question: 'Auth method scope' },
    { id: 's-openkt-ship-fast', source: 'voice', title: 'Ship fast', by: 'me', day: 2, time: '08:41', durationSec: 52, facts: ['f-openkt-28', 'f-openkt-22', 'f-openkt-23'] },
  ],
  facts: [
    { id: 'f-openkt-0', by: 'claude', kind: 'decision', page: 'p-openkt-embedding-vector-strategy', text: 'Chose Amazon Bedrock Titan v2 over BGE and OpenAI for embeddings — cheaper, IAM-native auth, and one embedding model across the whole system.' },
    { id: 'f-openkt-1', by: 'me', kind: 'decision', page: 'p-openkt-embedding-vector-strategy', text: 'The BGE embedding helper must not run anymore. We already have Titan working — one model, no double-embed.' },
    { id: 'f-openkt-2', by: 'claude', kind: 'how-to', page: 'p-openkt-embedding-vector-strategy', text: 'Eradicated BGE entirely; all embedding now goes through one canonical Titan module shared by server and worker.' },
    { id: 'f-openkt-3', by: 'me', kind: 'decision', page: 'p-openkt-database-infrastructure-consolidation', text: 'Super important: collapse MemMachine and OpenKT onto ONE Postgres. Our own infra, less ops, less downtime.' },
    { id: 'f-openkt-4', by: 'claude', kind: 'issue', page: 'p-openkt-memory-architecture-memmachine', text: 'Targeted two schemas (openkt + memmachine) but MM\'s Alembic migrations broke on a renamed schema, so MM now coexists in the public schema of the shared DB — same one-DB unlock without fighting MM.' },
    { id: 'f-openkt-5', by: 'claude', kind: 'fact', page: 'p-openkt-database-infrastructure-consolidation', text: 'Local stack ports: Postgres 15432, RabbitMQ 15673, MemMachine 18092, Neo4j 17687 — one shared Postgres for OpenKT and MM.' },
    { id: 'f-openkt-6', by: 'me', kind: 'decision', page: 'p-openkt-database-infrastructure-consolidation', text: 'Region for the consolidated server is us-east-1 — Singapore (ap-southeast-1) doesn\'t have Bedrock Titan v2 for our account.' },
    { id: 'f-openkt-7', by: 'server-agent', kind: 'how-to', page: 'p-openkt-database-infrastructure-consolidation', text: 'Don\'t run terraform without -target when the state has unapplied drift; it can apply unintended changes.' },
    { id: 'f-openkt-8', by: 'me', kind: 'decision', page: 'p-openkt-memory-architecture-memmachine', text: 'MemMachine and OpenKT are one system. We integrate ON TOP of MemMachine, not build our own parallel systems beside it.' },
    { id: 'f-openkt-9', by: 'claude', kind: 'how-to', page: 'p-openkt-memory-architecture-memmachine', text: 'MemMachine is the memory engine: ingest, extract episodic + semantic signals, and recall. OpenKT is the knowledge layer: curate MM\'s signals into the team knowledge base and then skills.' },
    { id: 'f-openkt-10', by: 'me', kind: 'decision', page: 'p-openkt-memory-architecture-memmachine', text: 'Recall stays MemMachine. OpenKT must not recall — the knowledge base is built by ingesting the signals MemMachine creates.' },
    { id: 'f-openkt-11', by: 'claude', kind: 'fact', page: 'p-openkt-memory-architecture-memmachine', text: 'MemMachine stores episodic memory in Neo4j and semantic features in Postgres; recall is delegated to MM\'s /search endpoint, not reimplemented in OpenKT.' },
    { id: 'f-openkt-12', by: 'claude', kind: 'issue', page: 'p-openkt-memory-architecture-memmachine', text: 'MemMachine\'s semantic features strip the contributor (they read \'User uses X\'), so forks — who disagrees with whom — are invisible in the feature layer and need the contributor-attributed source.' },
    { id: 'f-openkt-13', by: 'claude', kind: 'how-to', page: 'p-openkt-knowledge-base-synthesis', supersededBy: 'f-openkt-15', text: 'Knowledge bases used to cluster memories by cosine similarity >= 0.75 to a centroid.' },
    { id: 'f-openkt-14', by: 'me', kind: 'decision', page: 'p-openkt-knowledge-base-synthesis', text: 'Killing the cosine 0.75 KB threshold — it never clusters anything because Titan similarities for related memories are only 0.15 to 0.32. Move to LLM-based KB grouping.' },
    { id: 'f-openkt-15', by: 'claude', kind: 'decision', page: 'p-openkt-knowledge-base-synthesis', text: 'Retired the per-memory cosine classify_kb for a project-level LLM synthesis stage that clusters topics, writes current-state summaries, detects supersedes vs open forks, and forms relations.' },
    { id: 'f-openkt-16', by: 'me', kind: 'decision', page: 'p-openkt-knowledge-base-synthesis', text: 'No vague cosine logic gates. The knowledge base must be genuinely useful to an agent — better than the agent\'s own internal memory.' },
    { id: 'f-openkt-17', by: 'claude', kind: 'how-to', page: 'p-openkt-knowledge-base-synthesis', text: 'For the synthesis prompt, the simple v3 prompt beat the over-prescriptive v2 — over-prompting fragmented the output. Keep it lean.' },
    { id: 'f-openkt-18', by: 'claude', kind: 'decision', page: 'p-openkt-memory-architecture-memmachine', text: 'Proposed that recall return both layers — MemMachine\'s raw facts plus the synthesized OpenKT KB briefs in meta.knowledge_bases — so an agent gets everything in one call.' },
    { id: 'f-openkt-19', by: 'me', kind: 'decision', page: 'p-openkt-memory-architecture-memmachine', text: 'Disagree: recall must stay MemMachine-only and must NOT return both layers. The KB is built FROM MM\'s signals; it is not a second recall path bolted on.' },
    { id: 'f-openkt-20', by: 'me', kind: 'decision', page: 'p-openkt-authentication-access-control', text: 'Auth is email + password only — no magic links, no social login, ever.' },
    { id: 'f-openkt-21', by: 'claude', kind: 'how-to', page: 'p-openkt-authentication-access-control', text: 'Dual auth: Supabase JWT for the dashboard, Clerk webhook mirrors users and orgs into RDS, and one dispatcher resolves either token into one ActorContext.' },
    { id: 'f-openkt-22', by: 'me', kind: 'fact', page: 'p-openkt-product-vision-deployment', text: 'OpenKT is the context cloud for AI-native teams — knowledge bases so no agent repeats work that\'s already been done.' },
    { id: 'f-openkt-23', by: 'me', kind: 'decision', page: 'p-openkt-product-vision-deployment', text: 'Knowledge bases should convert into skills via the Create Skills plugin; OpenKT ships as a Claude Code plugin with prompts, skills, MCPs, and required scripts.' },
    { id: 'f-openkt-24', by: 'claude', kind: 'fact', page: 'p-openkt-pipeline-architecture-job', text: 'The per-memory pipeline is an explicit chain: preprocess -> embed (Titan) -> triage -> classify_kb, with mm-sync running in parallel and briefing on a 5-minute cron.' },
    { id: 'f-openkt-25', by: 'server-agent', kind: 'fact', page: 'p-openkt-pipeline-architecture-job', text: 'Every pipeline stage is tracked in agentic_jobs with idempotency keys, retries, and a dead-letter queue path.' },
    { id: 'f-openkt-26', by: 'claude', kind: 'issue', page: 'p-openkt-memory-architecture-memmachine', text: 'When MemMachine is unhealthy, OpenKT reads features directly from Postgres via Drizzle as a fallback so recall never hard-fails.' },
    { id: 'f-openkt-27', by: 'claude', kind: 'decision', page: 'p-openkt-embedding-vector-strategy', text: 'The embed stage calls Bedrock Titan directly for now (interim); once the single-Postgres collapse is done, OpenKT should REUSE MemMachine\'s stored Titan vector instead of embedding twice.' },
    { id: 'f-openkt-28', by: 'me', kind: 'decision', page: 'p-openkt-pipeline-architecture-job', text: 'Ship fast — we\'ve been building over a month and aren\'t out there yet. Correct + minimal + shipped beats complete + perfect + siloed.' },
    { id: 'f-openkt-29', by: 'server-agent', kind: 'fact', page: 'p-openkt-pipeline-architecture-job', text: 'server-agent ran the end-to-end shakeout on the local docker-compose stack: outbox -> preprocess -> embed -> triage -> episode -> briefing -> recall, PASSED.' },
  ],
  pages: [
    {
      id: 'p-openkt-memory-architecture-memmachine',
      title: 'Memory Architecture: MemMachine vs OpenKT Roles',
      by: ['claude', 'me'],
      stands: [
        ['MemMachine is the memory engine: ingest, extract episodic + semantic signals, recall via /search endpoint.', ['f-openkt-9']],
        ['OpenKT is the knowledge layer: synthesize MM\'s signals into team knowledge bases and skills.', ['f-openkt-9']],
        ['OpenKT does NOT recall; it builds FROM MemMachine\'s signals.', ['f-openkt-9', 'f-openkt-10']],
        ['Episodic memory in Neo4j; semantic features in Postgres.', ['f-openkt-11']],
        ['Recall never reimplemented in OpenKT.', ['f-openkt-11', 'f-openkt-26']],
      ],
      forks: [
        { topic: 'Recall return format: single vs dual layer', sides: [['claude', 'Recall returns both MemMachine raw facts + OpenKT KB briefs in meta.knowledge_bases', 'f-openkt-18'], ['me', 'Recall must stay MemMachine-only; KB is built FROM MM signals, not a second recall path', 'f-openkt-19']] },
      ],
      related: [
        ['p-openkt-database-infrastructure-consolidation', 'Shared Postgres stores both MemMachine semantic features and OpenKT signals; Neo4j episodic layer'],
        ['p-openkt-knowledge-base-synthesis', 'OpenKT synthesizes MemMachine signals into KBs; contributor attribution required for fork detection'],
        ['p-openkt-pipeline-architecture-job', 'Pipeline feeds MemMachine; mm-sync briefing bridges to OpenKT synthesis'],
      ],
    },
    {
      id: 'p-openkt-knowledge-base-synthesis',
      title: 'Knowledge Base Synthesis & Clustering',
      by: ['claude', 'me'],
      stands: [
        ['Retired cosine similarity threshold (0.75) — Titan similarities for related memories only 0.15–0.32, never clustered.', ['f-openkt-14']],
        ['Moved to LLM-based synthesis: project-level stage clusters topics, writes current-state summaries, detects supersedes vs open forks, forms relations.', ['f-openkt-15']],
        ['Simple v3 prompt outperformed over-prescriptive v2; kept lean.', ['f-openkt-17']],
        ['Forks require contributor-attributed sources (semantic features strip contributor).', ['f-openkt-12']],
      ],
      changes: [
        { topic: 'KB clustering method', now: 'LLM-based project-level synthesis with topic clustering', was: 'Cosine similarity >= 0.75 per-memory classify_kb', nowFact: 'f-openkt-15', wasFact: 'f-openkt-13' },
        { topic: 'Synthesis prompt complexity', now: 'Lean v3 prompt', was: 'Over-prescriptive v2 prompt', nowFact: 'f-openkt-17' },
      ],
      related: [
        ['p-openkt-memory-architecture-memmachine', 'OpenKT synthesizes MemMachine signals into KBs; contributor attribution required for fork detection'],
        ['p-openkt-product-vision-deployment', 'Synthesized KBs convert to skills; shipped as Claude Code plugin'],
      ],
    },
    {
      id: 'p-openkt-embedding-vector-strategy',
      title: 'Embedding & Vector Strategy',
      by: ['claude', 'me'],
      stands: [
        ['Single canonical embedding model: Amazon Bedrock Titan v2.', ['f-openkt-0']],
        ['Chosen for cost, IAM-native auth, and unified system architecture.', ['f-openkt-0']],
        ['BGE entirely eradicated.', ['f-openkt-2']],
        ['Interim: OpenKT calls Bedrock directly; post-DB-collapse: OpenKT will reuse MemMachine\'s stored Titan vectors to eliminate double-embedding.', ['f-openkt-27']],
      ],
      changes: [
        { topic: 'BGE embedding helper status', now: 'BGE eradicated; Titan only', was: 'BGE running in parallel', nowFact: 'f-openkt-2' },
      ],
      related: [
        ['p-openkt-database-infrastructure-consolidation', 'Bedrock Titan v2 region constraint (us-east-1) drives DB region choice'],
        ['p-openkt-pipeline-architecture-job', 'Embed stage calls Bedrock Titan; will reuse stored vectors post-DB-collapse'],
      ],
    },
    {
      id: 'p-openkt-database-infrastructure-consolidation',
      title: 'Database & Infrastructure Consolidation',
      by: ['claude', 'me', 'server-agent'],
      stands: [
        ['One shared Postgres (15432 locally) for both MemMachine and OpenKT.', ['f-openkt-5']],
        ['MemMachine coexists in public schema after Alembic migration workaround.', ['f-openkt-4']],
        ['Neo4j (17687) stores episodic memory.', ['f-openkt-5']],
        ['RabbitMQ (15673) for async jobs.', ['f-openkt-5']],
        ['Region: us-east-1 (Bedrock Titan v2 availability constraint; Singapore ap-southeast-1 unavailable).', ['f-openkt-6']],
        ['Terraform state drift must be managed with -target flag.', ['f-openkt-7']],
      ],
      changes: [
        { topic: 'MemMachine schema placement', now: 'MemMachine in public schema of shared DB', was: 'Separate openkt + memmachine schemas', nowFact: 'f-openkt-4' },
      ],
      related: [
        ['p-openkt-embedding-vector-strategy', 'Bedrock Titan v2 region constraint (us-east-1) drives DB region choice'],
        ['p-openkt-memory-architecture-memmachine', 'Shared Postgres stores both MemMachine semantic features and OpenKT signals; Neo4j episodic layer'],
      ],
    },
    {
      id: 'p-openkt-pipeline-architecture-job',
      title: 'Pipeline Architecture & Job Tracking',
      by: ['claude', 'server-agent'],
      stands: [
        ['Per-memory pipeline: preprocess → embed (Titan) → triage → classify_kb, with mm-sync running in parallel on 5-minute cron.', ['f-openkt-24']],
        ['Every stage tracked in agentic_jobs with idempotency keys, retries, dead-letter queue.', ['f-openkt-25']],
        ['Fallback: when MemMachine unhealthy, OpenKT reads features directly from Postgres via Drizzle so recall never hard-fails.', ['f-openkt-26']],
        ['End-to-end shakeout passed on local docker-compose.', ['f-openkt-29']],
      ],
      related: [
        ['p-openkt-embedding-vector-strategy', 'Embed stage calls Bedrock Titan; will reuse stored vectors post-DB-collapse'],
        ['p-openkt-memory-architecture-memmachine', 'Pipeline feeds MemMachine; mm-sync briefing bridges to OpenKT synthesis'],
      ],
    },
    {
      id: 'p-openkt-authentication-access-control',
      title: 'Authentication & Access Control',
      by: ['claude', 'me'],
      stands: [
        ['Email + password only — no magic links, no social login.', ['f-openkt-20']],
        ['Dual auth layer: Supabase JWT for dashboard; Clerk webhook mirrors users and orgs into RDS.', ['f-openkt-21']],
        ['One dispatcher resolves either token into ActorContext.', ['f-openkt-21']],
      ],
      forks: [
        { topic: 'Auth method scope', sides: [['me', 'Email + password only; no magic links or social login', 'f-openkt-20'], ['claude', 'Dual auth: Supabase JWT + Clerk webhook for flexibility', 'f-openkt-21']] },
      ],
      related: [
        ['p-openkt-product-vision-deployment', 'Auth gates dashboard and plugin access for AI-native teams'],
      ],
    },
    {
      id: 'p-openkt-product-vision-deployment',
      title: 'Product Vision & Deployment',
      by: ['me', 'claude'],
      stands: [
        ['OpenKT is the context cloud for AI-native teams — knowledge bases prevent agents from repeating work already done.', ['f-openkt-22']],
        ['Knowledge bases convert into skills via Create Skills plugin.', ['f-openkt-23']],
        ['OpenKT ships as Claude Code plugin with prompts, skills, MCPs, required scripts.', ['f-openkt-23']],
        ['Ship fast: correct + minimal + shipped beats complete + perfect + siloed.', ['f-openkt-28']],
        ['Month-long build cycle; ready to go live.', []],
      ],
      related: [
        ['p-openkt-knowledge-base-synthesis', 'Synthesized KBs convert to skills; shipped as Claude Code plugin'],
        ['p-openkt-authentication-access-control', 'Auth gates dashboard and plugin access for AI-native teams'],
      ],
    },
  ],
};
