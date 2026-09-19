import { z } from "zod";

export const UUID = z.string().uuid();
export const ISO = z.string().datetime({ offset: true });

export const GrantResourceTypeSchema = z.enum(["org", "project", "session"]);
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
