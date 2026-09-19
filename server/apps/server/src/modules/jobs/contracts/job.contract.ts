import { z } from "zod";

import { KINDS } from "../rules/living-rules";

// The job protocol between the server and a member's Mac (the "worker").
//
//   POST /v1/jobs/claim            {kinds?}            → {job, input} | {job: null}
//   POST /v1/jobs/:id/lookup       {facts:[{id, statement}]} → neighbours + candidate pages (extends the lease)
//   POST /v1/jobs/:id/complete     {result}            → what the server applied
//   POST /v1/jobs/:id/fail         {error, retry?}     → queued again with back-off, or failed
//
// Only the member who holds the lease may look up, complete or fail a job.

export const JOB_KINDS = ["process_session", "refresh_brief"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Spec 02 §10. */
export const MAX_ATTEMPTS = 6;
export const LEASE_MS = 5 * 60_000;

export const ClaimJobSchema = z.object({
  kinds: z.array(z.enum(JOB_KINDS)).min(1).max(JOB_KINDS.length).optional(),
  /** Free text shown on the space page: "Ana's MacBook · Qwen3.5-4B". */
  worker: z.string().max(120).optional(),
});
export type ClaimJobInput = z.infer<typeof ClaimJobSchema>;

export const JobIdParamsSchema = z.object({ id: z.string().uuid() });

export const LookupSchema = z.object({
  facts: z
    .array(z.object({ id: z.string().uuid(), statement: z.string().min(1).max(2000) }))
    .max(60),
});
export type LookupInput = z.infer<typeof LookupSchema>;

const Citeable = z.string().uuid();

export const ResultFactSchema = z.object({
  /** Chosen by the worker (a v4 uuid) so its sections can cite the fact before it exists. */
  id: z.string().uuid(),
  statement: z.string().min(1).max(2000),
  quote: z.string().min(1).max(2000),
  kind: z.enum(KINDS),
  tags: z.array(z.string().min(1).max(64)).max(8).default([]),
  duplicate_of: Citeable.nullable().default(null),
  supersedes: z.array(Citeable).max(10).default([]),
});
export type ResultFact = z.infer<typeof ResultFactSchema>;

export const ResultSectionSchema = z
  .object({
    /** An existing page in the job's space, or null with new_page_title. */
    page_id: z.string().uuid().nullable().default(null),
    new_page_title: z.string().min(1).max(200).nullable().default(null),
    /** An existing section of that page, or null with heading (a new section, or matched by heading). */
    section_id: z.string().uuid().nullable().default(null),
    heading: z.string().min(1).max(120),
    body_md: z.string().max(4000),
    mode: z.enum(["append", "rewrite_section", "fallback"]).default("append"),
  })
  .refine((s) => s.page_id !== null || s.new_page_title !== null, { message: "page_id or new_page_title is required" });
export type ResultSection = z.infer<typeof ResultSectionSchema>;

export const SessionResultSchema = z.object({
  summary: z
    .object({
      title: z.string().max(200),
      summary: z.string().max(2000),
      open_questions: z.array(z.string().max(500)).max(10).default([]),
    })
    .nullable()
    .default(null),
  facts: z.array(ResultFactSchema).max(120).default([]),
  sections: z.array(ResultSectionSchema).max(24).default([]),
  unrouted: z.array(z.object({ id: z.string().uuid(), reason: z.string().max(80) })).max(120).default([]),
  /** Model, runtime, timings, per-agent counts — stored as reported, never trusted for decisions. */
  stats: z.record(z.string(), z.unknown()).default({}),
});
export type SessionResult = z.infer<typeof SessionResultSchema>;

export const BriefResultSchema = z.object({
  /** Empty = keep the previous brief (the brief agent's safe no-op). */
  brief_md: z.string().max(6000),
  source_hash: z.string().max(128),
  stats: z.record(z.string(), z.unknown()).default({}),
});
export type BriefResult = z.infer<typeof BriefResultSchema>;

export const CompleteJobSchema = z.object({ result: z.unknown() });

export const FailJobSchema = z.object({
  error: z.string().max(2000),
  /** false: the input itself is the problem; do not hand it out again. */
  retry: z.boolean().default(true),
});
export type FailJobInput = z.infer<typeof FailJobSchema>;
