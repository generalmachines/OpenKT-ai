import { Pool, type QueryResult } from "pg";

// Standalone Postgres read helper for the GraphQueryService. The named
// Cypher library has a handful of Postgres-backed queries
// (episode_lineage, tag_contributors, project_overview) whose SQL is
// composed dynamically inside each query file using positional
// `$1`-style placeholders. Drizzle's templated `sql\`\`` API doesn't
// play well with that — `sql.raw()` accepts no params, and we don't
// want to push every query through a chain of fragment composition.
//
// So we cut a small back-channel here: a singleton pg.Pool built from
// the same DATABASE_URL the rest of the BFF uses. This is the same
// pattern @openkt/auth-authorization uses for its local fast path.

export class PostgresSession {
  private pool: Pool | null | undefined;

  // Lazily acquire the pool. Returns null when DATABASE_URL is unset
  // (which only happens in a couple of test paths).
  private getPool(): Pool | null {
    if (this.pool !== undefined) return this.pool;
    const url =
      process.env.DATABASE_URL ??
      process.env.DATA_POSTGRES_URL ??
      process.env.POSTGRES_URL ??
      null;
    if (!url) {
      this.pool = null;
      return null;
    }
    this.pool = new Pool({
      connectionString: url,
      max: Number(process.env.GRAPH_QUERY_POOL_MAX ?? 4),
      idleTimeoutMillis: 15_000,
      ssl: /^postgres:\/\/[^@]*@(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(url)
        ? undefined
        : { rejectUnauthorized: false },
    });
    return this.pool;
  }

  async runRead(sqlText: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error("DATABASE_URL is not configured");
    }
    const result: QueryResult<Record<string, unknown>> = await pool.query(sqlText, params);
    return result.rows;
  }

  // Visible for tests.
  setPool(pool: Pool | null): void {
    this.pool = pool;
  }
}
