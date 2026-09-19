// Production migration runner. Reads numbered SQL from
// apps/server/src/db/migrations/ and applies any not-yet-applied to
// DATABASE_URL. Run via `npm run db:migrate`.
//
// Distinct from `drizzle-kit push`, which is a dev-loop tool with no
// audit trail — push is fine for local iteration; migrate is what
// runs in CI / staging / prod.
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

config({ path: [".env.local", ".env"] });

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL ??
    process.env.DATA_POSTGRES_URL ??
    process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const pool = new Pool({
    connectionString: url,
    ssl: /supabase\.(com|co)/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool);
  console.log(`[db:migrate] applying migrations to ${url.replace(/:[^:@]*@/, ":****@")}`);
  await migrate(db, { migrationsFolder: "apps/server/src/db/migrations" });
  console.log("[db:migrate] done");
  await pool.end();
}

main().catch((err) => {
  console.error("[db:migrate] failed", err);
  process.exit(1);
});
