import { ValidationDomainError } from "@openkt/core-errors";

interface ProjectRef {
  orgId: string;
  projectId: string;
}

export interface MemMachineAddInput extends ProjectRef {
  content: string;
  producer: string;
  metadata: Record<string, string>;
}

export interface MemMachineSearchInput extends ProjectRef {
  query: string;
  limit: number;
}

export interface MemMachineSearchHit {
  openktMemoryId: string | null;
  externalId: string | null;
  // MemMachine namespace + project that returned this hit. Carried
  // through so the OpenKT side can scope external_ref lookups by
  // tenancy and never resolve a uid that belongs to a different
  // namespace.
  externalNamespace: string;
  externalProjectId: string;
  score: number | null;
}

type JsonRecord = Record<string, unknown>;

export class MemMachineClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  // Per-process memo of (org, project) tuples we've already ensured.
  // MemMachine's projects/create is idempotent (returns 409 when a
  // project exists) but we still pay the round-trip on every write.
  // Caching the success here makes addMemory a single HTTP hop after
  // the first call per project, per process.
  private readonly ensuredProjects = new Set<string>();

  constructor(baseUrl?: string, timeoutMs?: number) {
    this.baseUrl = (baseUrl ?? "http://127.0.0.1:8091").replace(/\/+$/, "");
    this.timeoutMs = timeoutMs ?? 20_000;
  }

  async ensureProject(ref: ProjectRef): Promise<void> {
    const key = `${ref.orgId}::${ref.projectId}`;
    if (this.ensuredProjects.has(key)) return;
    const response = await this.post("/api/v2/projects", {
      org_id: ref.orgId,
      project_id: ref.projectId,
      description: "OpenKT managed memory namespace",
    });

    if (response.ok || response.status === 409 || response.status === 422) {
      this.ensuredProjects.add(key);
      return;
    }
    await this.fail(response, "MemMachine project ensure failed");
  }

  async addMemory(input: MemMachineAddInput): Promise<string | null> {
    await this.ensureProject(input);
    const response = await this.post("/api/v2/memories", {
      org_id: input.orgId,
      project_id: input.projectId,
      types: ["episodic", "semantic"],
      messages: [
        {
          content: input.content,
          producer: input.producer,
          metadata: input.metadata,
        },
      ],
    });

    if (!response.ok) await this.fail(response, "MemMachine memory add failed");
    const body = await response.json() as JsonRecord;
    const results = Array.isArray(body.results) ? body.results : [];
    const first = this.asRecord(results[0]);
    return typeof first?.uid === "string" ? first.uid : null;
  }

  async search(input: MemMachineSearchInput): Promise<MemMachineSearchHit[]> {
    await this.ensureProject(input);
    const response = await this.post("/api/v2/memories/search", {
      org_id: input.orgId,
      project_id: input.projectId,
      query: input.query,
      top_k: input.limit,
      types: ["episodic", "semantic"],
      expand_context: 0,
      agent_mode: false,
    });

    if (!response.ok) await this.fail(response, "MemMachine memory search failed");
    const body = await response.json() as JsonRecord;
    return this.extractHits(body, input);
  }

  async deleteEpisodic(ref: ProjectRef, externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) return;
    const response = await this.post("/api/v2/memories/episodic/delete", {
      org_id: ref.orgId,
      project_id: ref.projectId,
      episodic_ids: externalIds,
    });
    if (!response.ok && response.status !== 404) {
      await this.fail(response, "MemMachine episodic delete failed");
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationDomainError(`MemMachine request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fail(response: Response, message: string): Promise<never> {
    const text = await response.text().catch(() => "");
    throw new ValidationDomainError(`${message}: ${response.status} ${text.slice(0, 500)}`);
  }

  private extractHits(body: JsonRecord, ref: ProjectRef): MemMachineSearchHit[] {
    const content = this.asRecord(body.content);
    const episodic = this.asRecord(content?.episodic_memory);
    const longTerm = this.asRecord(episodic?.long_term_memory);
    const shortTerm = this.asRecord(episodic?.short_term_memory);
    const semantic = this.asArray(content?.semantic_memory);
    const episodes = [
      ...this.asArray(longTerm?.episodes),
      ...this.asArray(shortTerm?.episodes),
      ...semantic,
    ];

    const hits: MemMachineSearchHit[] = [];
    for (const episode of episodes) {
      const row = this.asRecord(episode);
      const metadata = this.asRecord(row?.metadata);
      const other = this.asRecord(metadata?.other);
      const openktMemoryId = this.stringValue(metadata?.openkt_memory_id) ??
        this.stringValue(other?.openkt_memory_id);
      const externalId = this.stringValue(row?.uid) ??
        this.stringValue(metadata?.id) ??
        this.stringValue(other?.id);
      hits.push({
        openktMemoryId,
        externalId,
        externalNamespace: ref.orgId,
        externalProjectId: ref.projectId,
        score: typeof row?.score === "number" ? row.score : null,
      });
    }
    return hits;
  }

  private asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private stringValue(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
}
