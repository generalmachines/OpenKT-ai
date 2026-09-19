import { ConfigService } from "@nestjs/config";

import type { Neo4jRecordLike } from "../queries/types";

// Thin, dependency-tolerant Neo4j session helper used by
// GraphQueryService. Mirrors the lazy-import + degrade-on-missing
// pattern of Neo4jService — the spec says we may not modify
// `neo4j.service.ts`, but we still need a way to run an arbitrary
// read-only Cypher string. So this file replicates the bare-minimum
// driver lifecycle and exposes a single `runRead()` entrypoint.
//
// We deliberately do NOT cache the driver across calls. The named-
// query endpoint is low-volume (30/min/user rate limit) and the
// existing Neo4jService caches its own driver across the higher-volume
// graph endpoint; keeping a second long-lived driver would just double
// the file-descriptor budget for no win.

interface DriverShape {
  session(opts?: unknown): SessionShape;
  close(): Promise<void>;
}

interface SessionShape {
  run(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<{ records: Neo4jRecordLike[] }>;
  close(): Promise<void>;
}

interface Neo4jModule {
  driver: (uri: string, auth: unknown) => DriverShape;
  auth: { basic: (user: string, pass: string) => unknown };
}

export class Neo4jSessionUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Neo4jSessionUnavailableError";
  }
}

export interface Neo4jReadRunner {
  runRead(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<Neo4jRecordLike[]>;
}

export class Neo4jSession implements Neo4jReadRunner {
  constructor(private readonly config: ConfigService) {}

  private uri(): string | null {
    return (
      this.config.get<string>("OPENKT_MEMMACHINE_NEO4J_URI") ??
      this.config.get<string>("MEMMACHINE_NEO4J_URI") ??
      null
    );
  }

  private user(): string {
    return (
      this.config.get<string>("OPENKT_MEMMACHINE_NEO4J_USER") ??
      this.config.get<string>("MEMMACHINE_NEO4J_USER") ??
      "neo4j"
    );
  }

  private password(): string | null {
    return (
      this.config.get<string>("OPENKT_MEMMACHINE_NEO4J_PASSWORD") ??
      this.config.get<string>("MEMMACHINE_NEO4J_PASSWORD") ??
      null
    );
  }

  async runRead(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<Neo4jRecordLike[]> {
    const uri = this.uri();
    const password = this.password();
    if (!uri || !password) {
      throw new Neo4jSessionUnavailableError(
        "OPENKT_MEMMACHINE_NEO4J_URI / _PASSWORD not configured",
      );
    }

    let mod: Neo4jModule;
    try {
      mod = (await import("neo4j-driver")) as unknown as Neo4jModule;
    } catch (err) {
      throw new Neo4jSessionUnavailableError(
        `neo4j-driver not installed (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    const driver = mod.driver(uri, mod.auth.basic(this.user(), password));
    const session = driver.session();
    try {
      // Bolt servers default to READ on auto-commit sessions, but the
      // explicit option keeps it future-proof if we ever flip the
      // driver's default.
      const result = await session.run(cypher, params);
      return result.records;
    } finally {
      await session.close().catch(() => undefined);
      await driver.close().catch(() => undefined);
    }
  }
}
