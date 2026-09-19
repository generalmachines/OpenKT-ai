import { z } from "zod";

export const PageIdParamsSchema = z.object({ id: z.string().uuid() });
export const SectionParamsSchema = z.object({ id: z.string().uuid(), sid: z.string().uuid() });
export const ProjectParamsSchema = z.object({ id: z.string().min(1).max(256) });

/** A person's edit. Humans win: the section is locked against agents from now on (Spec 01 §5). */
export const EditSectionSchema = z.object({
  body_md: z.string().max(4000),
  heading: z.string().min(1).max(120).optional(),
});
export type EditSectionInput = z.infer<typeof EditSectionSchema>;
