import {
  GoneDomainError,
  NotFoundDomainError,
} from "../../libs/core/errors/src";
import { DeviceCodeService } from "../../apps/server/src/modules/auth/services/device-code.service";

interface DeviceCodeRow {
  code: string;
  status: "pending" | "confirmed" | "consumed" | "expired";
  userId: string | null;
  sessionData: { token?: string } | null;
  expiresAt: Date;
  confirmedAt?: Date | null;
  consumedAt?: Date | null;
}

function extractParams(condition: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const maybe = value as { value?: unknown; queryChunks?: unknown[] };
    if (typeof maybe.value === "string") out.push(maybe.value);
    for (const child of maybe.queryChunks ?? []) walk(child);
  };
  walk(condition);
  return out;
}

class FakeDrizzleDb {
  rows: DeviceCodeRow[] = [];

  insert() {
    return {
      values: async (row: Partial<DeviceCodeRow>) => {
        if (this.rows.some((r) => r.code === row.code)) {
          const err = new Error("duplicate") as Error & { code: string };
          err.code = "23505";
          throw err;
        }
        this.rows.push({
          code: row.code!,
          status: row.status ?? "pending",
          userId: row.userId ?? null,
          sessionData: row.sessionData ?? null,
          expiresAt: row.expiresAt!,
        });
      },
    };
  }

  select() {
    return {
      from: () => ({
        where: (condition: unknown) => ({
          limit: async () => {
            const [code] = extractParams(condition);
            return this.rows.filter((row) => row.code === code).slice(0, 1);
          },
        }),
      }),
    };
  }

  update() {
    return {
      set: (patch: Partial<DeviceCodeRow>) => ({
        where: async (condition: unknown) => {
          const [code, status] = extractParams(condition);
          const row = this.rows.find(
            (r) => r.code === code && (!status || r.status === status),
          );
          if (row) Object.assign(row, patch);
        },
      }),
    };
  }
}

const configService = {
  get: jest.fn((key: string) => {
    if (key === "OPENKT_DASHBOARD_URL") return "https://app.test";
    return undefined;
  }),
} as never;

describe("DeviceCodeService", () => {
  let db: FakeDrizzleDb;
  let service: DeviceCodeService;

  beforeEach(() => {
    db = new FakeDrizzleDb();
    service = new DeviceCodeService(db as never, configService);
  });

  it("start() returns a 10-char code from the safe alphabet and persists a pending row", async () => {
    const out = await service.start();
    expect(out.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(out.url).toBe(`https://app.test/signin/device?code=${out.code}`);
    const nowS = Math.floor(Date.now() / 1000);
    expect(out.expires_at).toBeGreaterThan(nowS);
    expect(out.expires_at).toBeLessThanOrEqual(nowS + 11 * 60);

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe("pending");
  });

  it("pollStatus() returns 'pending' before confirmation", async () => {
    const { code } = await service.start();
    expect(await service.pollStatus(code)).toEqual({ status: "pending" });
  });

  it("pollStatus() returns 'expired' for unknown codes (typo path)", async () => {
    expect(await service.pollStatus("ZZZZZZZZZZ")).toEqual({ status: "expired" });
  });

  it("pollStatus() returns 'expired' once the row's expires_at has passed", async () => {
    const { code } = await service.start();
    db.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await service.pollStatus(code)).toEqual({ status: "expired" });
  });

  it("confirm() flips a pending row to confirmed and stashes the JWT", async () => {
    const { code } = await service.start();
    await service.confirm("11111111-1111-4111-8111-111111111111", "the-jwt", code);
    const row = db.rows[0];
    expect(row.status).toBe("confirmed");
    expect(row.userId).toBe("11111111-1111-4111-8111-111111111111");
    expect(row.sessionData).toEqual({ token: "the-jwt" });
  });

  it("confirm() throws NotFoundDomainError for an unknown code", async () => {
    await expect(
      service.confirm("11111111-1111-4111-8111-111111111111", "the-jwt", "ZZZZZZZZZZ"),
    ).rejects.toBeInstanceOf(NotFoundDomainError);
  });

  it("confirm() throws GoneDomainError when the code already used", async () => {
    const { code } = await service.start();
    await service.confirm("11111111-1111-4111-8111-111111111111", "the-jwt", code);
    await expect(
      service.confirm("22222222-2222-4222-8222-222222222222", "another-jwt", code),
    ).rejects.toBeInstanceOf(GoneDomainError);
  });

  it("confirm() throws GoneDomainError when the code is expired", async () => {
    const { code } = await service.start();
    db.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(
      service.confirm("11111111-1111-4111-8111-111111111111", "the-jwt", code),
    ).rejects.toBeInstanceOf(GoneDomainError);
  });

  it("pollStatus() returns approved + token after confirm and consumes the row", async () => {
    const { code } = await service.start();
    await service.confirm("11111111-1111-4111-8111-111111111111", "the-jwt", code);
    expect(await service.pollStatus(code)).toEqual({
      status: "approved",
      token: "the-jwt",
    });
    expect(db.rows[0].status).toBe("consumed");
    expect(await service.pollStatus(code)).toEqual({ status: "expired" });
  });
});
