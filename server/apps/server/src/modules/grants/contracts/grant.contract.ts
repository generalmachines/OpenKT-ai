import { z } from "zod";

export const UUID = z.string().uuid();
export const ISO = z.string().datetime({ offset: true });

export const GrantResourceTypeSchema = z.enum(["org", "project", "session", "skill"]);
export type GrantResourceType = z.infer<typeof GrantResourceTypeSchema>;

export const GrantRoleSchema = z.enum(["reader", "editor", "owner"]);
export type GrantRole = z.infer<typeof GrantRoleSchema>;

export const GrantRecordSchema = z.object({
  id: UUID,
  org_id: UUID.nullable(),
  resource_type: GrantResourceTypeSchema,
  resource_id: UUID,
  subject_type: z.literal("user"),
  subject_id: UUID,
  role: GrantRoleSchema,
  created_by: UUID.nullable(),
  created_at: ISO,
});
export type GrantRecord = z.infer<typeof GrantRecordSchema>;

export const ResourceIdParamsSchema = z.object({ id: UUID });
export type ResourceIdParams = z.infer<typeof ResourceIdParamsSchema>;

export const GrantSubjectParamsSchema = z.object({
  id: UUID,
  userId: UUID,
});
export type GrantSubjectParams = z.infer<typeof GrantSubjectParamsSchema>;

export const PutGrantBodySchema = z.object({
  role: GrantRoleSchema,
});
export type PutGrantInput = z.infer<typeof PutGrantBodySchema>;

// Share by email — `PUT …/grants` (no user id in the path), so a client never
// has to ask a person for a user id. `subject_id` is accepted too, for callers
// that already hold one. Exactly one of the two.
export const PutGrantByEmailBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    subject_id: UUID.optional(),
    role: GrantRoleSchema,
  })
  .refine((v) => (v.email === undefined) !== (v.subject_id === undefined), {
    message: "give exactly one of email or subject_id",
  });
export type PutGrantByEmailInput = z.infer<typeof PutGrantByEmailBodySchema>;

// What the owner sees when listing: real grants with the person attached, and
// shares still waiting for their email to sign up.
export interface GrantSubjectView {
  id: string;
  email: string | null;
  display_name: string | null;
}

export type GrantView = GrantRecord & { pending: false; subject: GrantSubjectView };

export interface PendingGrantView {
  id: string;
  resource_type: GrantResourceType;
  resource_id: string;
  pending: true;
  email: string;
  role: GrantRole;
  created_by: string | null;
  created_at: string;
}

export type GrantListItem = GrantView | PendingGrantView;
