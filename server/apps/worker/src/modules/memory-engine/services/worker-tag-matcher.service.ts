import { Injectable } from "@nestjs/common";

import {
  EMBEDDING_DIM,
  embed,
  toPgVector,
} from "../../../../../server/src/modules/memory/repositories/embedding-bge";
import { WorkerPgService } from "../../database/worker-pg.service";

interface MatchCandidate {
  slug: string;
  displayName: string;
  rationale?: string;
}

export interface TagAliasResolution {
  // The original tag string the LLM returned, before normalization.
  input: string;
  // The normalized form ("rabbitmq", "rabbit-mq" and "RabbitMQ" all
  // collapse to "rabbit-mq" / "rabbitmq" depending on internal
  // separators). Stored so trace consumers see the dedup key the
  // matcher used.
  normalized: string;
  // The resolved tag's id + slug, regardless of whether it was a
  // brand-new insert or matched an existing row.
  tagId: string;
  tagSlug: string;
  // True when this string matched an existing tag (the LLM said
  // "RabbitMQ", we mapped it to a pre-existing "rabbitmq" tag).
  // False when we created a brand-new tag row for it.
  matchedExisting: boolean;
  // Cosine similarity to the matched tag's embedding when matched
  // via the embedding path; null when matched via the normalized-slug
  // path (no vector available for the new candidate) or when newly
  // created.
  similarity: number | null;
}

export interface TagMatchResult {
  tagIds: string[];
  resolutions: TagAliasResolution[];
}

/**
 * Tag clustering / dedup.
 *
 * The triage stage's LLM returns short topic slugs like ["RabbitMQ",
 * "rabbitmq", "rabbit-mq"], all of which should collapse to a single
 * tag row. Two layers of dedup:
 *
 *   1. Generic normalization — lowercase, trim, replace internal
 *      whitespace / underscores / hyphens with a single hyphen. So
 *      "RabbitMQ" / "rabbitmq" / "rabbit_mq" hash to the same string
 *      ("rabbitmq" or "rabbit-mq" depending on the original separator).
 *   2. Embedding-based — if the normalized slug doesn't exact-match an
 *      existing tag, embed the display name and search for the closest
 *      existing tag's embedding in the same tenancy. When cosine
 *      similarity ≥ OPENKT_TAG_DEDUP_SIMILARITY (default 0.85), reuse
 *      that tag id; otherwise create a new tag and persist its
 *      embedding for future dedup passes.
 */
@Injectable()
export class WorkerTagMatcherService {
  constructor(private readonly db: WorkerPgService) {}

  async match(input: {
    orgId: string | null;
    ownerUserId: string;
    candidates: MatchCandidate[];
  }): Promise<TagMatchResult> {
    const threshold = resolveThreshold();
    const resolutions: TagAliasResolution[] = [];
    const tagIds: string[] = [];

    for (const candidate of input.candidates) {
      const normalized = normalizeTagSlug(candidate.slug);
      if (!normalized) continue;

      const text = `${candidate.displayName}${
        candidate.rationale ? ` - ${candidate.rationale}` : ""
      }`;
      const vector = await embed(text);

      let resolvedId: string | null = null;
      let resolvedSlug: string = normalized;
      let matchedExisting = false;
      let similarity: number | null = null;

      // Embedding path — when we have a vector AND there's an existing
      // tag whose embedding is close enough, reuse it. This is the
      // primary dedup mechanism: "RabbitMQ" and "messaging-broker"
      // can both land on a single tag even when their slugs differ.
      if (vector && vector.length === EMBEDDING_DIM) {
        const best = await this.db.one<{
          id: string;
          slug: string;
          similarity: number;
        }>(
          input.orgId
            ? `select id, slug, (1 - (embedding <=> $2::vector))::real as similarity
                 from tags
                where org_id = $1 and embedding is not null
                order by embedding <=> $2::vector
                limit 1`
            : `select id, slug, (1 - (embedding <=> $2::vector))::real as similarity
                 from tags
                where org_id is null and owner_user_id = $1 and embedding is not null
                order by embedding <=> $2::vector
                limit 1`,
          [input.orgId ?? input.ownerUserId, toPgVector(vector)],
        );
        if (best && best.similarity >= threshold) {
          resolvedId = best.id;
          resolvedSlug = best.slug;
          matchedExisting = true;
          similarity = Number(best.similarity);
        }
      }

      // Slug-exact path — even if the embedding path didn't match (or
      // there was no vector), check whether the normalized slug
      // already exists. Falls through to insert when neither path
      // resolves a tag.
      if (!resolvedId) {
        const existing = await this.db.one<{ id: string; slug: string }>(
          input.orgId
            ? `select id, slug from tags where org_id = $1 and slug = $2 limit 1`
            : `select id, slug from tags where org_id is null and owner_user_id = $1 and slug = $2 limit 1`,
          [input.orgId ?? input.ownerUserId, normalized],
        );

        if (existing) {
          resolvedId = existing.id;
          resolvedSlug = existing.slug;
          matchedExisting = true;
        } else {
          const created = await this.db.one<{ id: string; slug: string }>(
            `insert into tags (org_id, owner_user_id, slug, display_name, embedding)
             values ($1, $2, $3, $4, $5::vector)
             on conflict do nothing
             returning id, slug`,
            [
              input.orgId,
              input.orgId ? null : input.ownerUserId,
              normalized,
              candidate.displayName,
              vector ? toPgVector(vector) : null,
            ],
          );
          if (created) {
            resolvedId = created.id;
            resolvedSlug = created.slug;
          } else {
            // Concurrent insert won the race — re-read.
            const reread = await this.db.one<{ id: string; slug: string }>(
              input.orgId
                ? `select id, slug from tags where org_id = $1 and slug = $2 limit 1`
                : `select id, slug from tags where org_id is null and owner_user_id = $1 and slug = $2 limit 1`,
              [input.orgId ?? input.ownerUserId, normalized],
            );
            if (reread) {
              resolvedId = reread.id;
              resolvedSlug = reread.slug;
              matchedExisting = true;
            }
          }
        }
      }

      if (resolvedId) {
        resolutions.push({
          input: candidate.slug,
          normalized,
          tagId: resolvedId,
          tagSlug: resolvedSlug,
          matchedExisting,
          similarity,
        });
        if (!tagIds.includes(resolvedId)) {
          tagIds.push(resolvedId);
        }
      }
    }

    return { tagIds, resolutions };
  }
}

// Lowercase, trim, replace internal whitespace + underscores + hyphens
// with a single hyphen. Exported for unit tests.
export function normalizeTagSlug(raw: string): string {
  if (!raw) return "";
  const lower = raw.toLowerCase().trim();
  // Collapse any run of [whitespace|hyphen|underscore] into a single hyphen.
  return lower.replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveThreshold(): number {
  const raw = process.env.OPENKT_TAG_DEDUP_SIMILARITY;
  if (!raw) return 0.85;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.85;
  return parsed;
}
