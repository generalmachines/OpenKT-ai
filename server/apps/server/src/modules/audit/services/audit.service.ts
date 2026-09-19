import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { auditLog } from "../../../db/schema";
import type { AuditActorKind } from "../contracts/audit.contract";

export interface AuditWriteInput {
  actorId?: string | null;
  actorKind: AuditActorKind;
  orgId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  request: {
    ip?: string | null;
    userAgent?: string | null;
    requestId: string;
  };
}

// AuditService — synchronous, throw-on-failure writer for the
// append-only audit_log table.
//
// V1 contract: callers `await auditService.write(...)` after the
// security-relevant write has succeeded. If the audit insert throws,
// the caller's surrounding transaction (or controller flow) should
// propagate the error — integrity > availability for security
// trails. A `tx` handle can be passed when the caller wants the audit
// row inside their existing Drizzle transaction; otherwise the global
// db handle is used.
//
// The table has DB-level triggers that reject UPDATE / DELETE, so
// neither this service nor a future buggy caller can rewrite history.
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async write(input: AuditWriteInput, tx?: DrizzleDb): Promise<void> {
    const conn = tx ?? this.db;
    try {
      await conn.insert(auditLog).values({
        actorId: input.actorId ?? null,
        actorKind: input.actorKind,
        orgId: input.orgId ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        before: (input.before ?? null) as never,
        after: (input.after ?? null) as never,
        // drizzle's `inet` column maps to string at the JS layer; null
        // is accepted because the column is nullable in the migration.
        ipInet: input.request.ip ?? null,
        userAgent: input.request.userAgent ?? null,
        requestId: input.request.requestId,
      });
    } catch (err) {
      // Log at error level — the caller will re-throw or roll back, but
      // we still want this in the structured logs for ops to pick up.
      this.logger.error(
        `audit_log write failed action=${input.action} actor=${
          input.actorId ?? "-"
        } org=${input.orgId ?? "-"}`,
        err as Error,
      );
      throw err;
    }
  }

  // Convenience helper that pulls actorId / requestId / ip / userAgent
  // off an ActorContext. Most callers want this; the lower-level write()
  // is exposed for non-HTTP code paths (workers, system-initiated jobs).
  async writeFromContext(
    context: ActorContext,
    fields: {
      actorKind: AuditActorKind;
      orgId?: string | null;
      action: string;
      resourceType?: string | null;
      resourceId?: string | null;
      before?: unknown;
      after?: unknown;
    },
    tx?: DrizzleDb,
  ): Promise<void> {
    await this.write(
      {
        actorId: context.principal.userId ?? null,
        actorKind: fields.actorKind,
        orgId: fields.orgId ?? null,
        action: fields.action,
        resourceType: fields.resourceType ?? null,
        resourceId: fields.resourceId ?? null,
        before: fields.before,
        after: fields.after,
        request: {
          ip: context.request.ip ?? null,
          userAgent: context.request.userAgent ?? null,
          // requestId is non-null in HTTP contexts because the
          // request-id middleware always assigns one; fall back to a
          // dash for the rare non-HTTP caller that supplies a context.
          requestId: context.request.requestId ?? "-",
        },
      },
      tx,
    );
  }
}
