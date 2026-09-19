import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ActorContext } from "@openkt/core-context";
import { requireProjectAccess } from "@openkt/auth-authorization";
import { ValidationDomainError } from "@openkt/core-errors";

import {
  QUERY_NAMES,
  assertReadOnlyCypher,
  getQuery,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "../queries";
import {
  Neo4jSession,
  Neo4jSessionUnavailableError,
  type Neo4jReadRunner,
} from "./neo4j-session";
import { Neo4jService } from "./neo4j.service";
import { PostgresSession } from "./postgres-session";

// Dispatcher for the named Cypher query library. The controller calls
// `execute` with the validated request body and a resolved
// `project_id`; the service handles whitelist enforcement, per-query
// param validation, and backend dispatch.
//
// Why a separate service from GraphService:
//   - GraphService is the existing Obsidian-style assembler that
//     produces a single composite graph for `GET /projects/.../graph`.
//   - GraphQueryService is the generic Cypher endpoint that runs
//     pre-registered named templates. They share Neo4jService for the
//     `isConfigured()` check but otherwise have unrelated control flow.

// Public shape of the dispatcher's return value. Matches the
// `data: { query, nodes, edges, stats, took_ms }` envelope the
// controller exposes.
export interface GraphQueryResponse {
  query: string;
  nodes: GraphLibraryResult["nodes"];
  edges: GraphLibraryResult["edges"];
  stats: Record<string, unknown>;
  took_ms: number;
}

interface NormalizedRecord extends Neo4jRecordLike {
  keys: string[];
  get: (key: string) => unknown;
  toObject: () => Record<string, unknown>;
}

@Injectable()
export class GraphQueryService {
  private readonly logger = new Logger(GraphQueryService.name);
  // Lazily-constructed Neo4j read runner. In tests we swap this for a
  // mock via `setNeo4jRunner()`.
  private neo4jRunner: Neo4jReadRunner;
  private pgSession: PostgresSession;

  constructor(
    private readonly neo4j: Neo4jService,
    config: ConfigService,
  ) {
    this.neo4jRunner = new Neo4jSession(config);
    this.pgSession = new PostgresSession();
  }

  // Test seams — production code never calls these.
  setNeo4jRunner(runner: Neo4jReadRunner): void {
    this.neo4jRunner = runner;
  }

  setPostgresSession(session: PostgresSession): void {
    this.pgSession = session;
  }

  static availableQueries(): string[] {
    return [...QUERY_NAMES];
  }

  async execute(
    context: ActorContext,
    projectId: string,
    body: { query: unknown; params: unknown },
  ): Promise<GraphQueryResponse> {
    // Project access is checked BEFORE we even look at the query name
    // — that way an unknown query for a project the user can't see
    // still produces a 403/404, not a 400 leak.
    await requireProjectAccess(context, projectId, "read");

    const queryName = typeof body.query === "string" ? body.query : null;
    if (!queryName) {
      throw new ValidationDomainError("unknown_query", {
        reason: "query name is required",
        available: QUERY_NAMES,
      });
    }
    const definition = getQuery(queryName);
    if (!definition) {
      throw new ValidationDomainError("unknown_query", {
        reason: `unknown query name: ${queryName}`,
        query: queryName,
        available: QUERY_NAMES,
      });
    }

    const paramsResult = definition.paramSchema.safeParse(body.params ?? {});
    if (!paramsResult.success) {
      throw new ValidationDomainError("invalid_params", {
        query: queryName,
        issues: paramsResult.error.flatten(),
      });
    }

    const { cypher, params } = definition.buildCypher(paramsResult.data, projectId);
    // Defense-in-depth: even though library queries are static, scan
    // for write keywords before sending to the backend.
    assertReadOnlyCypher(cypher);

    const start = Date.now();
    let records: NormalizedRecord[];
    try {
      if (definition.backend === "neo4j") {
        records = await this.runNeo4j(cypher, params);
      } else {
        records = await this.runPostgres(cypher, params);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof Neo4jSessionUnavailableError) {
        throw new HttpException(
          {
            code: "graph_unavailable",
            message: "neo4j backend is unavailable",
            details: { query: queryName, backend: "neo4j", reason: err.message },
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.logger.warn(
        `graph query '${queryName}' failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new HttpException(
        {
          code: "graph_unavailable",
          message: "graph backend is currently unavailable",
          details: {
            query: queryName,
            backend: definition.backend,
            reason: err instanceof Error ? err.message : String(err),
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const parsed = definition.parseResult(records);
    const tookMs = Date.now() - start;

    const stats: Record<string, unknown> = { ...(parsed.stats ?? {}) };
    stats.node_count = parsed.nodes.length;
    stats.edge_count = parsed.edges.length;

    return {
      query: queryName,
      nodes: parsed.nodes,
      edges: parsed.edges,
      stats,
      took_ms: tookMs,
    };
  }

  // ── backends ─────────────────────────────────────────────────────────

  private async runNeo4j(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<NormalizedRecord[]> {
    if (!this.neo4j.isConfigured()) {
      throw new Neo4jSessionUnavailableError(
        "neo4j backend is not configured",
      );
    }
    const records = await this.neo4jRunner.runRead(cypher, params);
    return records.map(normalizeNeo4jRecord);
  }

  private async runPostgres(
    sqlText: string,
    params: Record<string, unknown>,
  ): Promise<NormalizedRecord[]> {
    const ordered = orderedParams(params);
    const rows = await this.pgSession.runRead(sqlText, ordered);
    return rows.map(rowToRecord);
  }

}

// ── helpers ─────────────────────────────────────────────────────────

function orderedParams(params: Record<string, unknown>): unknown[] {
  // Accept {"$1": ..., "$2": ...} keyed params and produce a positional
  // list in numerical order. Unknown keys are silently dropped — the
  // SQL strings only reference `$N` placeholders anyway.
  const numericKeys = Object.keys(params)
    .filter((k) => /^\$\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return numericKeys.map((k) => params[k]);
}

function normalizeNeo4jRecord(record: Neo4jRecordLike): NormalizedRecord {
  const keys = record.keys;
  return {
    keys,
    get: (key: string) => record.get(key),
    toObject: () => {
      if (record.toObject) return record.toObject();
      const out: Record<string, unknown> = {};
      for (const key of keys) out[key] = record.get(key);
      return out;
    },
  };
}

function rowToRecord(row: Record<string, unknown>): NormalizedRecord {
  const keys = Object.keys(row);
  return {
    keys,
    get: (key: string) => row[key],
    toObject: () => row,
  };
}
