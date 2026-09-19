import { z } from "zod";

// Shapes only. The folder rules (count, size, paths, frontmatter) live in
// services/skill-files.ts so they answer with their own 422 codes instead of
// a generic "invalid request payload".
const UUID = z.string().uuid();

export const SkillFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const SkillRoleSchema = z.enum(["owner", "editor", "reader"]);
export type SkillRole = z.infer<typeof SkillRoleSchema>;

export const SkillSurfaceSchema = z.enum(["app", "mcp", "api"]);
export type SkillSurface = z.infer<typeof SkillSurfaceSchema>;

const Title = z.string().trim().min(1).max(200);
const ChangeNote = z.string().trim().max(500);

export const SkillIdParamsSchema = z.object({ id: UUID });
export const SkillVersionParamsSchema = z.object({
  id: UUID,
  n: z.coerce.number().int().min(1),
});
export const SkillGrantParamsSchema = z.object({ id: UUID, grantId: UUID });

export const ListSkillsQuerySchema = z.object({
  project_id: z.string().trim().min(1).max(256).optional(),
  q: z.string().trim().max(200).optional(),
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
export type ListSkillsQuery = z.infer<typeof ListSkillsQuerySchema>;

// `files` (the whole folder) or `skill_md` (just SKILL.md) or neither — then
// the server writes a starter SKILL.md from the title.
export const CreateSkillSchema = z
  .object({
    title: Title,
    project_id: z.string().trim().min(1).max(256).nullable().optional(),
    files: z.array(SkillFileSchema).optional(),
    skill_md: z.string().optional(),
    change_note: ChangeNote.nullable().optional(),
  })
  .refine((v) => !(v.files && v.skill_md !== undefined), { message: "give files or skill_md, not both" });
export type CreateSkillInput = z.infer<typeof CreateSkillSchema>;

export const SaveSkillVersionSchema = z.object({
  files: z.array(SkillFileSchema),
  change_note: ChangeNote.nullable().optional(),
  title: Title.optional(),
  base_version: z.number().int().min(1),
});
export type SaveSkillVersionInput = z.infer<typeof SaveSkillVersionSchema>;

export const PatchSkillSchema = z
  .object({
    // null moves the skill out of any space: personal to its owner.
    project_id: z.string().trim().min(1).max(256).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.project_id !== undefined || v.archived !== undefined, {
    message: "give project_id or archived",
  });
export type PatchSkillInput = z.infer<typeof PatchSkillSchema>;

export const RecordSkillRunSchema = z.object({
  surface: SkillSurfaceSchema.default("api"),
});

// ── responses ──────────────────────────────────────────────────────

export interface SkillPersonView {
  id: string;
  display_name: string | null;
}

export interface SkillSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  project_id: string | null;
  space_name: string | null;
  owner: SkillPersonView;
  current_version: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
  run_count: number;
  run_count_30d: number;
  my_role: SkillRole;
}

export interface SkillFileView {
  path: string;
  content: string;
  bytes: number;
}

export interface SkillVersionSummary {
  version: number;
  change_note: string | null;
  created_by: SkillPersonView;
  created_at: string;
}

export interface SkillDetail extends SkillSummary {
  files: SkillFileView[];
  versions: SkillVersionSummary[];
}

export interface SkillVersionDetail extends SkillVersionSummary {
  skill_id: string;
  files: SkillFileView[];
}
