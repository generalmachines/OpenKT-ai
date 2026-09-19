import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import type {
  AuditListQuery,
  AuditListResponse,
  AuditLogRowOut,
  AuditActorKind,
} from "../contracts/audit.contract";

@Injectable()
export class AuditQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Paginated list of audit_log rows for an org. The RBAC check
  // (admin-role) is done in the controller's guard layer; this service
  // assumes the caller is permitted to see the org's full trail.
  async listForOrg(orgId: string, query: AuditListQuery): Promise<AuditListResponse> {
    const cursorDate = parseIsoDate(query.cursor);
    const sinceDate = parseIsoDate(query.since);
    const untilDate = parseIsoDate(query.until);

    const limit = query.limit;
    const result = await this.db.execute(sql`
      select id, actor_id, actor_kind, org_id, action, resource_type,
             resource_id, before, after,
             host(ip_inet) as ip_inet,
             user_agent, request_id, occurred_at
      from audit_log
      where org_id = ${orgId}::uuid
        and (${query.actor_id ?? null}::uuid is null or actor_id = ${query.actor_id ?? null}::uuid)
        and (${query.action ?? null}::text is null or action = ${query.action ?? null}::text)
        and (${query.resource_type ?? null}::text is null or resource_type = ${query.resource_type ?? null}::text)
        and (${query.resource_id ?? null}::text is null or resource_id = ${query.resource_id ?? null}::text)
        and (${sinceDate ?? null}::timestamptz is null or occurred_at >= ${sinceDate ?? null}::timestamptz)
        and (${untilDate ?? null}::timestamptz is null or occurred_at <= ${untilDate ?? null}::timestamptz)
        and (${cursorDate ?? null}::timestamptz is null or occurred_at < ${cursorDate ?? null}::timestamptz)
      order by occurred_at desc, id desc
      limit ${limit + 1}
    `);

    const rows = result.rows.map(rowToAuditOut);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1]?.occurred_at ?? null : null;
    return { items, next_cursor: nextCursor };
  }
}

function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function rowToAuditOut(row: Record<string, unknown>): AuditLogRowOut {
  return {
    id: row.id as string,
    actor_id: (row.actor_id as string | null) ?? null,
    actor_kind: row.actor_kind as AuditActorKind,
    org_id: (row.org_id as string | null) ?? null,
    action: row.action as string,
    resource_type: (row.resource_type as string | null) ?? null,
    resource_id: (row.resource_id as string | null) ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    ip_inet: (row.ip_inet as string | null) ?? null,
    user_agent: (row.user_agent as string | null) ?? null,
    request_id: row.request_id as string,
    occurred_at: new Date(row.occurred_at as string).toISOString(),
  };
}
