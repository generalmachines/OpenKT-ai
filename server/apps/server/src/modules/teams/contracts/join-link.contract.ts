import { z } from "zod";

// A team is a space other people can join. A join link says "anyone with
// this link can join <space> as <role>"; opening it creates an ordinary grant.

export const JoinRoleSchema = z.enum(["reader", "editor"]);
export type JoinRole = z.infer<typeof JoinRoleSchema>;

export const DEFAULT_LINK_DAYS = 30;
export const MAX_LINK_DAYS = 365;
export const MAX_LINK_USES = 10_000;

export const CreateJoinLinkBodySchema = z.object({
  role: JoinRoleSchema.default("editor"),
  expires_in_days: z.coerce.number().int().min(1).max(MAX_LINK_DAYS).default(DEFAULT_LINK_DAYS),
  max_uses: z.coerce.number().int().min(1).max(MAX_LINK_USES).nullish(),
});
export type CreateJoinLinkInput = z.infer<typeof CreateJoinLinkBodySchema>;

// A code is 10 characters from [A-Za-z0-9]; accept a little slack so a
// future longer code still parses.
export const JoinCodeSchema = z.string().regex(/^[A-Za-z0-9]{6,32}$/, "not a join code");

export const JoinBodySchema = z.object({ code: z.string().min(1).max(500) });

export const ProjectIdParamsSchema = z.object({ id: z.string().uuid() });
export const ProjectCodeParamsSchema = z.object({ id: z.string().uuid(), code: JoinCodeSchema });
// Any string: a malformed code is simply a link that does not exist (404).
export const CodeParamsSchema = z.object({ code: z.string().min(1).max(64) });

export interface JoinLinkView {
  code: string;
  url: string;
  space_id: string;
  role: JoinRole;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  active: boolean;
}

export interface JoinPreview {
  space_name: string;
  inviter_name: string;
  role: JoinRole;
}

export interface JoinResult {
  space: { id: string; name: string };
  role: "reader" | "editor" | "owner";
}
