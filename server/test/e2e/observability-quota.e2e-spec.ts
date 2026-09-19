import { ConfigService } from "@nestjs/config";

import {
  DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP,
  UserQuotaService,
  currentWindow,
} from "../../apps/server/src/modules/observability/services/user-quota.service";

const USER_ID = "11111111-1111-1111-1111-111111111111";

interface RowSet {
  rows: Array<Record<string, unknown>>;
}

function fakeDb(opts: {
  selectRow?: Record<string, unknown> | null;
  onInsert?: (sql: string) => void;
}) {
  const executions: string[] = [];
  return {
    executions,
    execute: jest.fn(async (statement: { sql?: string; queryChunks?: unknown }): Promise<RowSet> => {
      // drizzle-orm sql template tag exposes the `sql` string on .sql
      // when toSQL is called; for the testing shim we just stringify
      // and look at the keywords. Real prod calls go through a real Pool.
      const stmt = stringifyStatement(statement);
      executions.push(stmt);
      if (stmt.includes("insert into user_quotas")) {
        opts.onInsert?.(stmt);
        return { rows: [] };
      }
      if (stmt.includes("from user_quotas")) {
        return { rows: opts.selectRow ? [opts.selectRow] : [] };
      }
      return { rows: [] };
    }),
  };
}

function stringifyStatement(statement: unknown): string {
  if (statement && typeof statement === "object") {
    const maybeSql = (statement as { sql?: unknown }).sql;
    if (typeof maybeSql === "string") return maybeSql;
    const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      return chunks
        .map((chunk) => {
          if (chunk && typeof chunk === "object" && "value" in (chunk as object)) {
            return String((chunk as { value: unknown }).value ?? "");
          }
          return String(chunk ?? "");
        })
        .join(" ");
    }
  }
  return String(statement);
}

function makeConfig(values: Record<string, string | number | undefined> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

describe("UserQuotaService", () => {
  it("returns allowed=true with no quota row (fresh user)", async () => {
    const db = fakeDb({});
    const service = new UserQuotaService(db as never, makeConfig());

    const result = await service.checkAndReserve(USER_ID, "minimax", 100);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.remainingTokens).toBe(DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP);
  });

  it("returns allowed=false (with remaining=0) when projected use exceeds limit", async () => {
    const window = currentWindow("monthly");
    const db = fakeDb({
      selectRow: {
        tokens_used: DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP,
        tokens_limit: DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP,
      },
    });
    const service = new UserQuotaService(db as never, makeConfig());

    const result = await service.checkAndReserve(USER_ID, "minimax", 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("quota_exceeded");
    expect(result.remainingTokens).toBe(0);
    expect(window.start.getTime()).toBeLessThan(window.end.getTime());
  });

  it("respects OPENKT_MINIMAX_MONTHLY_TOKEN_CAP override", async () => {
    const db = fakeDb({});
    const service = new UserQuotaService(
      db as never,
      makeConfig({ OPENKT_MINIMAX_MONTHLY_TOKEN_CAP: "500" }),
    );

    const result = await service.checkAndReserve(USER_ID, "minimax", 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("quota_exceeded");
  });

  it("ignores unknown providers (no cap configured) and short-circuits", async () => {
    const db = fakeDb({});
    const service = new UserQuotaService(db as never, makeConfig());

    const result = await service.checkAndReserve(USER_ID, "anthropic", 999_999);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.remainingTokens).toBeNull();
    // We never read or wrote a quota row.
    expect(db.executions).toHaveLength(0);
  });

  it("commitUsage emits an upsert against user_quotas", async () => {
    let captured = "";
    const db = fakeDb({
      onInsert: (sql) => {
        captured = sql;
      },
    });
    const service = new UserQuotaService(db as never, makeConfig());

    await service.commitUsage(USER_ID, "minimax", 1234, 0.0042);
    expect(captured).toContain("insert into user_quotas");
    expect(captured.toLowerCase()).toContain("on conflict");
  });

  it("commitUsage no-ops without a user", async () => {
    const db = fakeDb({});
    const service = new UserQuotaService(db as never, makeConfig());

    await service.commitUsage(null, "minimax", 1234, 0.0042);
    expect(db.executions).toHaveLength(0);
  });

  it("returns a synthetic empty-window quota for users who have never spent", async () => {
    const db = fakeDb({});
    const service = new UserQuotaService(db as never, makeConfig());

    const quota = await service.getCurrentQuota(USER_ID, "minimax");
    expect(quota).not.toBeNull();
    expect(quota?.tokens_used).toBe(0);
    expect(quota?.tokens_limit).toBe(DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP);
    expect(quota?.period_kind).toBe("monthly");
  });
});
