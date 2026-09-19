import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Pool, type QueryResultRow } from "pg";

@Injectable()
export class WorkerPgService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerPgService.name);
  private readonly pool: Pool;

  constructor() {
    const url =
      process.env.DATABASE_URL ??
      process.env.DATA_POSTGRES_URL ??
      process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is required for worker database access");
    this.pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      ssl: /supabase\.(com|co)/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    this.logger.log(`worker db ready (${url.replace(/:[^:@]*@/, ":****@")})`);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, params);
    return result.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
