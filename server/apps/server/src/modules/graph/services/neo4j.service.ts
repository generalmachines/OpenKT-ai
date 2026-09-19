import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Thin, dependency-tolerant Neo4j client used by the graph endpoint
// to read the MemMachine substrate (entities + relationships) for a
// project. The neo4j-driver package is loaded on first use via a
// dynamic `import()` so the BFF can boot — and the rest of the test
// suite can run — even if the dep isn't installed (e.g. fresh CI
// before `npm install`).
//
// When Neo4j is unreachable or unconfigured we degrade gracefully:
// the graph endpoint still returns memories + episodes + similarity,
// just with no `mentions` edges. Stats.neo4j_available signals which
// is the case.

export interface Neo4jEntityNode {
  id: string;
  label: string;
  entityKind: string | null;
  neo4jNodeId: string;
}

export interface Neo4jMentionEdge {
  // Either memory_id or episode_id depending on which substrate the
  // mention was recorded against. Stored as raw string from neo4j.
  source: string;
  // The entity OpenKT id we stamp on the node (entity_<slug>).
  target: string;
  weight: number | null;
}

export interface Neo4jLabelCount {
  labels: string[];
  count: number;
}

export interface Neo4jRelTypeCount {
  type: string;
  count: number;
}

export interface Neo4jAudit {
  available: boolean;
  reason: string | null;
  labelCounts: Neo4jLabelCount[];
  relationshipCounts: Neo4jRelTypeCount[];
  sampleNodeProperties: Record<string, string[]>;
}

interface DriverShape {
  session(opts?: unknown): SessionShape;
  close(): Promise<void>;
}

interface SessionShape {
  run(cypher: string, params?: Record<string, unknown>): Promise<{
    records: Array<{
      keys: string[];
      get: (key: string) => unknown;
      toObject: () => Record<string, unknown>;
    }>;
  }>;
  close(): Promise<void>;
}

interface Neo4jModule {
  driver: (uri: string, auth: unknown) => DriverShape;
  auth: { basic: (user: string, pass: string) => unknown };
}

@Injectable()
export class Neo4jService implements OnModuleDestroy {
  private readonly logger = new Logger(Neo4jService.name);
  private driverPromise: Promise<DriverShape | null> | null = null;

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    const uri = this.uri();
    const password = this.password();
    return !!(uri && password);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.driverPromise) return;
    const driver = await this.driverPromise.catch(() => null);
    if (driver) await driver.close().catch(() => undefined);
  }

  // Returns null when Neo4j is unconfigured or unreachable.
  private async getDriver(): Promise<DriverShape | null> {
    if (!this.isConfigured()) return null;
    if (!this.driverPromise) {
      this.driverPromise = this.connect().catch((err) => {
        this.logger.warn(
          `Neo4j connect failed; degrading to no-graph mode: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });
    }
    return this.driverPromise;
  }

  private async connect(): Promise<DriverShape | null> {
    const uri = this.uri();
    const user = this.user();
    const password = this.password();
    if (!uri || !password) return null;

    let neo4jModule: Neo4jModule;
    try {
      // Optional dependency. Imported lazily so the BFF still boots
      // and tests still run when the package isn't installed.
      neo4jModule = (await import("neo4j-driver")) as unknown as Neo4jModule;
    } catch (err) {
      this.logger.warn(
        `neo4j-driver not available (${
          err instanceof Error ? err.message : String(err)
        }); skip mentions edges`,
      );
      return null;
    }

    return neo4jModule.driver(uri, neo4jModule.auth.basic(user, password));
  }

  private uri(): string | null {
    return (
      this.configService.get<string>("OPENKT_MEMMACHINE_NEO4J_URI") ??
      this.configService.get<string>("MEMMACHINE_NEO4J_URI") ??
      null
    );
  }

  private user(): string {
    return (
      this.configService.get<string>("OPENKT_MEMMACHINE_NEO4J_USER") ??
      this.configService.get<string>("MEMMACHINE_NEO4J_USER") ??
      "neo4j"
    );
  }

  private password(): string | null {
    return (
      this.configService.get<string>("OPENKT_MEMMACHINE_NEO4J_PASSWORD") ??
      this.configService.get<string>("MEMMACHINE_NEO4J_PASSWORD") ??
      null
    );
  }

  // ── Read paths used by the graph endpoint ─────────────────────────

  // Pull entity nodes referenced by the project's MemMachine namespace.
  // Returns an empty array when Neo4j is unavailable so the caller can
  // still produce a useful graph without mentions edges.
  async listEntitiesForProject(args: {
    orgId: string | null;
    projectId: string;
    ownerUserId: string;
    limit: number;
  }): Promise<Neo4jEntityNode[]> {
    const driver = await this.getDriver();
    if (!driver) return [];
    const session = driver.session();
    try {
      const namespace = args.orgId ?? `personal:${args.ownerUserId}`;
      // MemMachine writes entities with several possible labels.
      // We match on the entity-style labels seen in the prod audit
      // and filter by `project_id` (it's stored as a property on
      // both the entity node and the relationship). Both forms are
      // tried — the audit picks whichever the live database uses.
      const result = await session.run(
        `
          MATCH (e)
          WHERE (any(label IN labels(e) WHERE label IN ['Entity','SemanticEntity','Concept']))
            AND (
              coalesce(e.project_id, '') = $projectId
              OR coalesce(e.tenant_id, '') = $projectId
              OR coalesce(e.namespace, '') = $namespace
            )
          RETURN
            id(e) AS node_id,
            coalesce(e.name, e.label, e.id, toString(id(e))) AS name,
            coalesce(e.entity_kind, e.type, head(labels(e))) AS kind
          LIMIT $limit
        `,
        {
          projectId: args.projectId,
          namespace,
          limit: this.intParam(args.limit),
        },
      );

      const nodes: Neo4jEntityNode[] = [];
      for (const record of result.records) {
        const nodeId = String(record.get("node_id"));
        const name = String(record.get("name") ?? "").trim();
        const kind = (record.get("kind") as string | null) ?? null;
        const id = `ent_${slugifyEntity(name || nodeId)}`;
        nodes.push({
          id,
          label: name || `entity ${nodeId}`,
          entityKind: kind,
          neo4jNodeId: nodeId,
        });
      }
      return dedupeEntities(nodes);
    } catch (err) {
      this.logger.warn(
        `entities query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  // Pull MENTIONS edges between memories/episodes and entities,
  // scoped to the project's MemMachine namespace.
  async listMentionEdgesForProject(args: {
    orgId: string | null;
    projectId: string;
    ownerUserId: string;
    limit: number;
  }): Promise<Neo4jMentionEdge[]> {
    const driver = await this.getDriver();
    if (!driver) return [];
    const session = driver.session();
    try {
      const namespace = args.orgId ?? `personal:${args.ownerUserId}`;
      const result = await session.run(
        `
          MATCH (m)-[r]->(e)
          WHERE (any(label IN labels(e) WHERE label IN ['Entity','SemanticEntity','Concept']))
            AND type(r) IN ['MENTIONS','REFERS_TO','ABOUT','HAS_ENTITY']
            AND (
              coalesce(r.project_id, m.project_id, '') = $projectId
              OR coalesce(r.tenant_id, m.tenant_id, '') = $projectId
              OR coalesce(m.namespace, '') = $namespace
            )
          RETURN
            coalesce(m.openkt_memory_id, m.openkt_episode_id, m.uid, toString(id(m))) AS source,
            coalesce(e.name, e.label, e.id, toString(id(e))) AS target_name,
            coalesce(r.weight, r.score, 1.0) AS weight,
            startNode(r) = m AS source_is_start
          LIMIT $limit
        `,
        {
          projectId: args.projectId,
          namespace,
          limit: this.intParam(args.limit),
        },
      );

      const edges: Neo4jMentionEdge[] = [];
      for (const record of result.records) {
        const sourceRaw = String(record.get("source") ?? "");
        const targetName = String(record.get("target_name") ?? "").trim();
        if (!sourceRaw || !targetName) continue;
        const weight = this.toNumber(record.get("weight"));
        const source = this.prefixMemoryOrEpisode(sourceRaw);
        edges.push({
          source,
          target: `ent_${slugifyEntity(targetName)}`,
          weight,
        });
      }
      return edges;
    } catch (err) {
      this.logger.warn(
        `mentions query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  // One-off investigation step. Returns a snapshot of node labels and
  // relationship types living in Neo4j. The PR description quotes this
  // so reviewers can see what we're actually pointing at.
  async audit(): Promise<Neo4jAudit> {
    if (!this.isConfigured()) {
      return {
        available: false,
        reason: "OPENKT_MEMMACHINE_NEO4J_URI / _PASSWORD not configured",
        labelCounts: [],
        relationshipCounts: [],
        sampleNodeProperties: {},
      };
    }
    const driver = await this.getDriver();
    if (!driver) {
      return {
        available: false,
        reason: "driver unavailable (neo4j-driver missing or connect failed)",
        labelCounts: [],
        relationshipCounts: [],
        sampleNodeProperties: {},
      };
    }

    const session = driver.session();
    try {
      const labels = await session.run(
        "MATCH (n) RETURN labels(n) AS labels, count(*) AS count ORDER BY count DESC LIMIT 50",
      );
      const labelCounts: Neo4jLabelCount[] = labels.records.map((record) => ({
        labels: ((record.get("labels") as string[] | null) ?? []).map((label) => String(label)),
        count: this.toInt(record.get("count")),
      }));

      const rels = await session.run(
        "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC LIMIT 50",
      );
      const relationshipCounts: Neo4jRelTypeCount[] = rels.records.map((record) => ({
        type: String(record.get("type") ?? ""),
        count: this.toInt(record.get("count")),
      }));

      const props: Record<string, string[]> = {};
      for (const labelRow of labelCounts.slice(0, 6)) {
        const head = labelRow.labels[0];
        // Skip anything that isn't a plain Cypher identifier — the
        // label gets interpolated into the query so we won't allow
        // backticks or quotes to slip in.
        if (!head || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(head)) continue;
        const sample = await session.run(
          `MATCH (n:\`${head}\`) RETURN keys(n) AS keys LIMIT 1`,
        );
        const keys = sample.records[0]?.get("keys") as string[] | null;
        if (keys && Array.isArray(keys)) {
          props[head] = keys.map((k) => String(k));
        }
      }

      return {
        available: true,
        reason: null,
        labelCounts,
        relationshipCounts,
        sampleNodeProperties: props,
      };
    } catch (err) {
      return {
        available: false,
        reason: `audit query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        labelCounts: [],
        relationshipCounts: [],
        sampleNodeProperties: {},
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────

  private prefixMemoryOrEpisode(raw: string): string {
    if (raw.startsWith("mem_") || raw.startsWith("ep_")) return raw;
    // UUIDs from the openkt_memory_id metadata column: assume memory.
    if (/^[0-9a-f-]{36}$/i.test(raw)) return `mem_${raw}`;
    return raw;
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (
      typeof value === "object" &&
      value !== null &&
      "toNumber" in value &&
      typeof (value as { toNumber: () => number }).toNumber === "function"
    ) {
      try {
        return (value as { toNumber: () => number }).toNumber();
      } catch {
        return null;
      }
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toInt(value: unknown): number {
    return Math.max(0, Math.floor(this.toNumber(value) ?? 0));
  }

  // neo4j-driver requires integer params to be wrapped via `int()` when
  // running on Bolt. Loading the helper through the same dynamic-import
  // module shape would couple this file to the driver — instead we pass
  // a plain integer and let the driver coerce, which works for LIMIT.
  private intParam(value: number): number {
    return Math.max(1, Math.floor(value));
  }
}

function slugifyEntity(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "unknown";
}

function dedupeEntities(nodes: Neo4jEntityNode[]): Neo4jEntityNode[] {
  const seen = new Map<string, Neo4jEntityNode>();
  for (const node of nodes) {
    if (!seen.has(node.id)) seen.set(node.id, node);
  }
  return Array.from(seen.values());
}
