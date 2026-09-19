#!/usr/bin/env node
/**
 * One-shot migration: copy every BFF-relevant table from the live
 * Supabase Postgres into local pg. Idempotent — INSERT ... ON
 * CONFLICT (id) DO NOTHING — so it's safe to re-run after pulling
 * incremental data.
 *
 * Tables migrated, in FK order:
 *   1. orgs                          (no FK to anything we need)
 *   2. profiles                      (Supabase auth.users → public.profiles)
 *   3. users                         (synthetic from profiles + bcrypt hashes
 *                                     pulled from auth.users)
 *   4. org_members
 *   5. projects
 *   6. tags
 *   7. memories                      (with synthesis columns if Supabase has them)
 *   8. memory_tags
 *   9. memory_accesses               (large table, paginated)
 *  10. team_briefings                (if exists on Supabase)
 *  11. member_knowledge              (renamed from team_pulse_events in
 *                                     migration 0016 — destination table
 *                                     keeps the legacy event-stream columns
 *                                     nullable for back-compat)
 *  12. project_code_graphs           (if exists on Supabase)
 *
 * Env required:
 *   SUPABASE_DB_URL    — read-only postgres URL pointing at Supabase pooler
 *   DATABASE_URL       — local pg URL (DATA_POSTGRES_URL also accepted)
 *
 * Optional:
 *   ONLY=table1,table2 — limit which tables to migrate
 *   SKIP_AUTH=1        — skip pulling bcrypt hashes from auth schema
 *
 * Usage:
 *   SUPABASE_DB_URL='postgres://…@…pooler.supabase.com:6543/postgres' \
 *   DATABASE_URL='postgres://openkt:openkt@127.0.0.1:15432/openkt' \
 *   node scripts/migrate-from-supabase.mjs
 */
import pg from "pg";

const SUPABASE_URL = process.env.SUPABASE_DB_URL;
const LOCAL_URL = process.env.DATABASE_URL ?? process.env.DATA_POSTGRES_URL;
if (!SUPABASE_URL || !LOCAL_URL) {
  console.error("error: SUPABASE_DB_URL and DATABASE_URL required");
  process.exit(2);
}
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const SKIP_AUTH = process.env.SKIP_AUTH === "1";

const supa = new pg.Pool({
  connectionString: SUPABASE_URL.replace(/\?sslmode=require$/, ""),
  max: 4,
  ssl: { rejectUnauthorized: false },
});
const local = new pg.Pool({ connectionString: LOCAL_URL, max: 4 });

const should = (table) => !ONLY || ONLY.has(table);

async function copy(table, selectSql, insertSql, mapper, { batchSize = 1000 } = {}) {
  if (!should(table)) {
    console.log(`  ~ ${table}: skipped (ONLY filter)`);
    return 0;
  }
  let totalInserted = 0;
  let offset = 0;
  for (;;) {
    const { rows } = await supa.query(`${selectSql} ORDER BY 1 LIMIT ${batchSize} OFFSET ${offset}`);
    if (rows.length === 0) break;
    for (const row of rows) {
      const params = mapper(row);
      try {
        const result = await local.query(insertSql, params);
        if (result.rowCount > 0) totalInserted += 1;
      } catch (err) {
        console.warn(`  ! ${table} insert failed: ${err.message}`);
      }
    }
    offset += rows.length;
    if (rows.length < batchSize) break;
  }
  console.log(`  ✓ ${table}: ${totalInserted} new rows`);
  return totalInserted;
}

async function tableExistsOnSupabase(schema, table) {
  const { rows } = await supa.query(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schema, table],
  );
  return rows[0]?.exists === true;
}

async function columnExists(schema, table, column) {
  const { rows } = await supa.query(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     ) AS exists`,
    [schema, table, column],
  );
  return rows[0]?.exists === true;
}

async function main() {
  console.log(`[migrate] Supabase → ${LOCAL_URL.replace(/:[^:@]*@/, ":****@")}`);

  // 1. orgs
  await copy(
    "orgs",
    `SELECT id, slug, name, plan, created_by, created_at FROM public.orgs`,
    `INSERT INTO public.orgs (id, slug, name, plan, created_by, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6) ON CONFLICT (id) DO NOTHING`,
    (r) => [r.id, r.slug, r.name, r.plan, r.created_by, r.created_at],
  );

  // 2. profiles
  await copy(
    "profiles",
    `SELECT user_id, email, display_name, created_at FROM public.profiles`,
    `INSERT INTO public.profiles (user_id, email, display_name, created_at)
     VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
    (r) => [r.user_id, r.email, r.display_name, r.created_at],
  );

  // 3. users — synthetic from profiles, bcrypt hash pulled from auth schema if available
  if (!SKIP_AUTH) {
    const haveAuth = await tableExistsOnSupabase("auth", "users");
    if (haveAuth) {
      await copy(
        "users",
        `SELECT u.id, u.email, u.encrypted_password, u.email_confirmed_at,
                p.display_name, u.created_at, u.updated_at, u.last_sign_in_at
           FROM auth.users u
           LEFT JOIN public.profiles p ON p.user_id = u.id`,
        `INSERT INTO public.users
           (id, email, password_hash, email_verified, display_name, created_at, updated_at, last_sign_in_at)
         VALUES ($1::uuid, $2, $3, $4::boolean, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        (r) => [
          r.id, r.email, r.encrypted_password, r.email_confirmed_at != null,
          r.display_name, r.created_at, r.updated_at, r.last_sign_in_at,
        ],
      );
    } else {
      console.log("  ~ users: auth.users not visible — skipping bcrypt pull");
    }
  }

  // 4. org_members
  await copy(
    "org_members",
    `SELECT org_id, user_id, role, invited_by, joined_at FROM public.org_members`,
    `INSERT INTO public.org_members (org_id, user_id, role, invited_by, joined_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5) ON CONFLICT DO NOTHING`,
    (r) => [r.org_id, r.user_id, r.role, r.invited_by, r.joined_at],
  );

  // 5. projects
  await copy(
    "projects",
    `SELECT id, org_id, slug, name, visibility::text, owner_user_id, created_at, updated_at
       FROM public.projects`,
    `INSERT INTO public.projects (id, org_id, slug, name, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::public.project_visibility, $6::uuid, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    (r) => [r.id, r.org_id, r.slug, r.name, r.visibility, r.owner_user_id, r.created_at, r.updated_at],
  );

  // 6. tags
  await copy(
    "tags",
    `SELECT id, org_id, owner_user_id, slug, display_name, description, use_count, created_at, updated_at
       FROM public.tags`,
    `INSERT INTO public.tags
       (id, org_id, owner_user_id, slug, display_name, description, use_count, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
    (r) => [
      r.id, r.org_id, r.owner_user_id, r.slug, r.display_name,
      r.description, r.use_count, r.created_at, r.updated_at,
    ],
  );

  // 7. memories — the big one. Pull synthesis columns when Supabase has them,
  // null otherwise.
  const hasTier = await columnExists("public", "memories", "tier");
  const synthCols = hasTier
    ? `, m.tier, m.sub_points, m.contributors, m.scores, m.rolls_up_memory_count, m.confidence_history`
    : `, NULL AS tier, '{}'::text[] AS sub_points, '[]'::jsonb AS contributors,
       NULL::jsonb AS scores, 1 AS rolls_up_memory_count, '{}'::int[] AS confidence_history`;
  await copy(
    "memories",
    `SELECT m.id, m.org_id, m.project_id, m.owner_user_id, m.content, m.kind::text,
            m.category, m.visibility::text, m.confidence, m.importance, m.decay_lambda,
            m.importance_at, m.recall_count, m.archived, m.created_at, m.updated_at,
            m.source_refs, m.is_pinned ${synthCols}
       FROM public.memories m`,
    `INSERT INTO public.memories
       (id, org_id, project_id, owner_user_id, content, kind, category, visibility,
        confidence, importance, decay_lambda, importance_at, recall_count, archived,
        created_at, updated_at, source_refs, is_pinned,
        tier, sub_points, contributors, scores, rolls_up_memory_count, confidence_history)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::public.memory_kind, $7,
             $8::public.memory_visibility, $9, $10, $11, $12, $13, $14, $15, $16,
             $17::jsonb, $18,
             $19, $20::text[], $21::jsonb, $22::jsonb, $23, $24::int[])
     ON CONFLICT (id) DO NOTHING`,
    (r) => [
      r.id, r.org_id, r.project_id, r.owner_user_id, r.content, r.kind,
      r.category, r.visibility, r.confidence, r.importance, r.decay_lambda,
      r.importance_at, r.recall_count, r.archived, r.created_at, r.updated_at,
      r.source_refs, r.is_pinned ?? false,
      r.tier, r.sub_points ?? [], r.contributors ?? [], r.scores,
      r.rolls_up_memory_count ?? 1, r.confidence_history ?? [],
    ],
  );

  // 8. memory_tags
  await copy(
    "memory_tags",
    `SELECT memory_id, tag_id, added_at FROM public.memory_tags`,
    `INSERT INTO public.memory_tags (memory_id, tag_id, added_at)
     VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`,
    (r) => [r.memory_id, r.tag_id, r.added_at],
  );

  // 9. memory_accesses
  if (await tableExistsOnSupabase("public", "memory_accesses")) {
    await copy(
      "memory_accesses",
      `SELECT id, memory_id, actor_user_id, action, surface, at FROM public.memory_accesses`,
      `INSERT INTO public.memory_accesses (id, memory_id, actor_user_id, action, surface, at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      (r) => [r.id, r.memory_id, r.actor_user_id, r.action, r.surface, r.at],
      { batchSize: 5000 },
    );
  }

  // 10. team_briefings — only if Supabase has them (likely doesn't yet)
  if (await tableExistsOnSupabase("public", "team_briefings")) {
    await copy(
      "team_briefings",
      `SELECT id, project_id, org_id, generated_at, generated_by, briefing_md, model,
              prompt_tokens, completion_tokens, source_memory_count_at_generation,
              source_memory_ids, is_current FROM public.team_briefings`,
      `INSERT INTO public.team_briefings
         (id, project_id, org_id, generated_at, generated_by, briefing_md, model,
          prompt_tokens, completion_tokens, source_memory_count_at_generation,
          source_memory_ids, is_current)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10,
               $11::uuid[], $12) ON CONFLICT (id) DO NOTHING`,
      (r) => [
        r.id, r.project_id, r.org_id, r.generated_at, r.generated_by, r.briefing_md,
        r.model, r.prompt_tokens, r.completion_tokens, r.source_memory_count_at_generation,
        r.source_memory_ids, r.is_current,
      ],
    );
  }

  // 11. member_knowledge (was team_pulse_events on Supabase, renamed in 0016)
  if (await tableExistsOnSupabase("public", "team_pulse_events")) {
    await copy(
      "member_knowledge",
      `SELECT id, project_id, org_id, kind, actor, actor_role, verb, target,
              target_ref, body, badges, related_insight_id, ts FROM public.team_pulse_events`,
      `INSERT INTO public.member_knowledge
         (id, project_id, org_id, kind, actor, actor_role, verb, target,
          target_ref, body, badges, related_insight_id, ts)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::uuid, $13)
       ON CONFLICT (id) DO NOTHING`,
      (r) => [
        r.id, r.project_id, r.org_id, r.kind, r.actor, r.actor_role, r.verb,
        r.target, r.target_ref, r.body, r.badges, r.related_insight_id, r.ts,
      ],
    );
  }

  // 12. project_code_graphs
  if (await tableExistsOnSupabase("public", "project_code_graphs")) {
    const hasGraphJson = await columnExists("public", "project_code_graphs", "graph_json");
    const col = hasGraphJson ? "graph_json" : "graph";
    await copy(
      "project_code_graphs",
      `SELECT project_id, ${col} AS graph_json, node_count, edge_count, file_count,
              indexed_by, indexed_at, created_at, updated_at, is_public, share_token, shared_at
         FROM public.project_code_graphs`,
      `INSERT INTO public.project_code_graphs
         (project_id, graph_json, node_count, edge_count, file_count,
          indexed_by, indexed_at, created_at, updated_at, is_public, share_token, shared_at)
       VALUES ($1::uuid, $2::jsonb, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (project_id) DO NOTHING`,
      (r) => [
        r.project_id, r.graph_json, r.node_count, r.edge_count, r.file_count,
        r.indexed_by, r.indexed_at, r.created_at, r.updated_at,
        r.is_public ?? false, r.share_token, r.shared_at,
      ],
    );
  }

  console.log("[migrate] done");
  await supa.end();
  await local.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
