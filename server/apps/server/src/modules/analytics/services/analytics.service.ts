import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

export interface AnalyticsEmitInput {
  event: string;
  userId?: string | null;
  orgId?: string | null;
  projectId?: string | null;
  properties?: Record<string, unknown>;
  client: string;
  sessionId?: string | null;
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

// AnalyticsService.emit() — fire-and-forget. Caller awaits if they want
// to, but any DB failure is caught + logged. Analytics MUST NOT break
// the request — losing a row is acceptable; throwing into a controller
// is not.
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async emit(input: AnalyticsEmitInput): Promise<void> {
    try {
      const properties = input.properties ?? {};
      await this.db.execute(sql`
        insert into analytics_events (
          event, user_id, org_id, project_id, properties, client,
          session_id, request_id, ip_inet, user_agent
        )
        values (
          ${input.event},
          ${input.userId ?? null}::uuid,
          ${input.orgId ?? null}::uuid,
          ${input.projectId ?? null}::uuid,
          ${JSON.stringify(properties)}::jsonb,
          ${input.client},
          ${input.sessionId ?? null},
          ${input.requestId},
          ${input.ip ?? null}::inet,
          ${input.userAgent ?? null}
        )
      `);
    } catch (err) {
      this.logger.warn(
        `analytics.emit failed event=${input.event} request_id=${input.requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
