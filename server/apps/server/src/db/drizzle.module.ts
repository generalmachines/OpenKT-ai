import { Global, Logger, Module } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

// One pg pool, one Drizzle client, exposed via DI for the entire BFF.
// All modules that need data access inject DRIZZLE.
//
// DATABASE_URL is the single env knob — point it at local pg for dev,
// at Supabase pg-pooler for prod, at a CI test DB for tests. There is
// no env-driven repo swap anymore; the ORM is the abstraction.

export const DRIZZLE = Symbol("DRIZZLE");
// Canonical Drizzle node-postgres type. Plays cleanly with tx typing
// and survives `drizzle()` overload changes — preferred over
// `ReturnType<typeof drizzle<…>>`.
export type DrizzleDb = NodePgDatabase<typeof schema>;

const drizzleProvider = {
  provide: DRIZZLE,
  useFactory: () => {
    const url =
      process.env.DATABASE_URL ??
      process.env.DATA_POSTGRES_URL ??
      process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("DATABASE_URL is required");
    }
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      // Cloud Postgres (Supabase, AWS RDS) ships a CA-signed or self-signed
      // cert and rejects plain-TCP clients. Trust the cert for any non-local
      // host; local pg gets plain TCP.
      ssl: /^postgres:\/\/[^@]*@(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(url)
        ? undefined
        : { rejectUnauthorized: false },
    });
    const db = drizzle(pool, { schema, logger: process.env.DATABASE_LOG === "1" });
    new Logger("DrizzleModule").log(
      `db ready (${url.replace(/:[^:@]*@/, ":****@")})`,
    );
    return db;
  },
};

@Global()
@Module({
  providers: [drizzleProvider],
  exports: [drizzleProvider],
})
export class DrizzleModule {}
