import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"] });

const url =
  process.env.DATABASE_URL ??
  process.env.DATA_POSTGRES_URL ??
  "postgres://openkt:openkt@127.0.0.1:15432/openkt";

export default defineConfig({
  schema: "./apps/server/src/db/schema/index.ts",
  out: "./apps/server/src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
