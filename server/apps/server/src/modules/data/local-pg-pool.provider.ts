import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { Pool } from "pg";

// Local-Postgres pool. The data layer for the new modules
// (briefings, member_knowledge) goes through this so the BFF can run end-to-end
// against a dev Postgres without touching the live Supabase. Auth
// stays on Supabase (SupabaseJwtGuard verifies tokens) — only the
// query layer is local.
//
// Reads DATABASE_URL from env. DATA_POSTGRES_URL and POSTGRES_URL are
// temporary compatibility aliases while older docs/scripts are removed.

@Injectable()
export class LocalPgPool implements OnModuleDestroy {
  private readonly logger = new Logger(LocalPgPool.name);
  private readonly pool: Pool;

  constructor(@Optional() @Inject("DATABASE_URL") pgUrl?: string) {
    const url =
      pgUrl ??
      process.env.DATABASE_URL ??
      process.env.DATA_POSTGRES_URL ??
      process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set — Postgres data layer cannot start.");
    }
    this.pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATA_POSTGRES_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
    this.logger.log(`local-pg pool ready (${url.replace(/:[^:@]*@/, ":****@")})`);
  }

  // Thin wrapper — returns rows directly. Callers convert row shapes.
  async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }

  async one<T = unknown>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
