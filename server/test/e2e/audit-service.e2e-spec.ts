/**
 * Unit-style spec for AuditService.write().
 *
 * Covers:
 *  - Happy path: builds an INSERT against audit_log with the expected
 *    columns mapped from camelCase input to snake-case DB columns.
 *  - Failure path: a thrown DB error propagates (so the surrounding
 *    transaction / controller flow rolls back — integrity > availability).
 *
 * The Drizzle handle is mocked via the same `.insert(table).values(row)`
 * builder API the real client exposes. The append-only trigger is tested
 * separately against a real Postgres in audit-immutability.e2e-spec.ts
 * (skipped when DATABASE_URL is unset).
 */
import { AuditService } from "../../apps/server/src/modules/audit/services/audit.service";
import { auditLog } from "../../apps/server/src/db/schema";

interface CapturedInsert {
  table: unknown;
  values: Record<string, unknown>;
}

function fakeDb(opts: { onInsert?: () => void } = {}): {
  inserts: CapturedInsert[];
  handle: unknown;
} {
  const inserts: CapturedInsert[] = [];
  const handle = {
    insert(table: unknown) {
      return {
        values: (row: Record<string, unknown>) => {
          opts.onInsert?.();
          inserts.push({ table, values: row });
          return Promise.resolve();
        },
      };
    },
  };
  return { inserts, handle };
}

describe("AuditService", () => {
  it("inserts the expected row shape into audit_log", async () => {
    const { inserts, handle } = fakeDb();
    const service = new AuditService(handle as never);

    await service.write({
      actorId: "11111111-1111-1111-1111-111111111111",
      actorKind: "user",
      orgId: "22222222-2222-2222-2222-222222222222",
      action: "org.invite.created",
      resourceType: "org_invite",
      resourceId: "33333333-3333-3333-3333-333333333333",
      after: { invite_id: "33333333-3333-3333-3333-333333333333", role: "member" },
      request: {
        ip: "203.0.113.10",
        userAgent: "jest",
        requestId: "req-abc",
      },
    });

    expect(inserts).toHaveLength(1);
    const [{ table, values }] = inserts;
    expect(table).toBe(auditLog);
    expect(values.actorId).toBe("11111111-1111-1111-1111-111111111111");
    expect(values.actorKind).toBe("user");
    expect(values.orgId).toBe("22222222-2222-2222-2222-222222222222");
    expect(values.action).toBe("org.invite.created");
    expect(values.resourceType).toBe("org_invite");
    expect(values.resourceId).toBe("33333333-3333-3333-3333-333333333333");
    expect(values.after).toEqual({
      invite_id: "33333333-3333-3333-3333-333333333333",
      role: "member",
    });
    expect(values.ipInet).toBe("203.0.113.10");
    expect(values.userAgent).toBe("jest");
    expect(values.requestId).toBe("req-abc");
  });

  it("defaults nullable fields to null when omitted", async () => {
    const { inserts, handle } = fakeDb();
    const service = new AuditService(handle as never);

    await service.write({
      actorKind: "system",
      action: "memory.hard_deleted",
      resourceType: "memory",
      resourceId: "mem-1",
      request: { requestId: "req-sys" },
    });

    expect(inserts).toHaveLength(1);
    const { values } = inserts[0];
    expect(values.actorId).toBeNull();
    expect(values.orgId).toBeNull();
    expect(values.before).toBeNull();
    expect(values.after).toBeNull();
    expect(values.userAgent).toBeNull();
  });

  it("uses the supplied tx handle when provided (so caller-driven rollback works)", async () => {
    const { inserts: dbInserts, handle: dbHandle } = fakeDb();
    const { inserts: txInserts, handle: txHandle } = fakeDb();
    const service = new AuditService(dbHandle as never);

    await service.write(
      {
        actorKind: "user",
        action: "org.invite.revoked",
        request: { requestId: "req-tx" },
      },
      txHandle as never,
    );

    expect(dbInserts).toHaveLength(0);
    expect(txInserts).toHaveLength(1);
  });

  it("propagates DB errors so callers can roll back", async () => {
    const handle = {
      insert: () => ({
        values: () => Promise.reject(new Error("constraint failed")),
      }),
    };
    const service = new AuditService(handle as never);

    await expect(
      service.write({
        actorKind: "user",
        action: "org.invite.created",
        request: { requestId: "req-x" },
      }),
    ).rejects.toThrow("constraint failed");
  });

  it("writeFromContext pulls actor + request metadata off the context", async () => {
    const { inserts, handle } = fakeDb();
    const service = new AuditService(handle as never);

    const context = {
      principal: { userId: "u-1", type: "user" },
      request: {
        ip: "198.51.100.4",
        userAgent: "ua-test",
        requestId: "req-ctx",
      },
    } as never;

    await service.writeFromContext(context, {
      actorKind: "user",
      orgId: "org-1",
      action: "org.invite.created",
      resourceType: "org_invite",
      resourceId: "i-1",
      after: { role: "admin" },
    });

    expect(inserts).toHaveLength(1);
    const { values } = inserts[0];
    expect(values.actorId).toBe("u-1");
    expect(values.ipInet).toBe("198.51.100.4");
    expect(values.userAgent).toBe("ua-test");
    expect(values.requestId).toBe("req-ctx");
    expect(values.action).toBe("org.invite.created");
  });
});
