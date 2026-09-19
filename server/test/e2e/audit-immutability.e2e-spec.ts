/**
 * DB-level immutability spec for audit_log.
 *
 * Confirms that the BEFORE UPDATE / BEFORE DELETE triggers installed
 * by migration 0019_audit_log raise on any mutation attempt — the
 * append-only guarantee is enforced even against the app-role.
 *
 * Skipped when DATABASE_URL is not set (CI without Postgres). When it
 * is set we expect the migration to have been applied (npm run
 * db:migrate up front).
 */
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

const REQUEST_ID = "audit-immutability-spec";

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("audit_log immutability (db integration)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /^postgres:\/\/[^@]*@(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(
        DATABASE_URL ?? "",
      )
        ? undefined
        : { rejectUnauthorized: false },
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertRow(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into audit_log (actor_kind, action, request_id)
       values ('system', 'test.spec.row', $1)
       returning id`,
      [REQUEST_ID],
    );
    return rows[0].id;
  }

  it("rejects UPDATE with the trigger error", async () => {
    const id = await insertRow();
    await expect(
      pool.query(`update audit_log set action = 'mutated' where id = $1`, [id]),
    ).rejects.toThrow(/audit_log is append-only/);
  });

  it("rejects DELETE with the trigger error", async () => {
    const id = await insertRow();
    await expect(
      pool.query(`delete from audit_log where id = $1`, [id]),
    ).rejects.toThrow(/audit_log is append-only/);
  });

  it("INSERT is still permitted (sanity check)", async () => {
    const id = await insertRow();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
