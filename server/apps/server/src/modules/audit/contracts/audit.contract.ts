import { z } from "zod";

// Zod contracts for the v1 audit surface. Snake-case is the wire shape;
// the controller parses with these schemas so any drift between dashboard
// expectations and runtime returns 422 rather than silently shipping a
// wrong-shape payload.

export const Uuid = z.string().uuid();

export const AuditActorKindSchema = z.enum([
  "user",
  "service",
  "api_key",
  "admin",
  "system",
]);
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

export const AuditOrgParamSchema = z.object({ org_id: Uuid });

export const AuditListQuerySchema = z
  .object({
    actor_id: Uuid.optional(),
    action: z.string().min(1).max(128).optional(),
    resource_type: z.string().min(1).max(64).optional(),
    resource_id: z.string().min(1).max(256).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    // Cursor is the ISO timestamp of the last row from the previous page;
    // pagination is keyset over (occurred_at DESC, id) but we expose just
    // the timestamp at the wire (id is implied by it falling before the
    // boundary). 100 is the hard cap.
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .passthrough();
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export interface AuditLogRowOut {
  id: string;
  actor_id: string | null;
  actor_kind: AuditActorKind;
  org_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  ip_inet: string | null;
  user_agent: string | null;
  request_id: string;
  occurred_at: string;
}

export interface AuditListResponse {
  items: AuditLogRowOut[];
  next_cursor: string | null;
}
