import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";
import type {
  CreateOrgRecord,
  OrgDetailRecord,
  OrgMemberRecord,
  OrgRepository,
  OrgSummaryRecord,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { orgMembers, orgs, profiles } from "../../../db/schema";

// Drop-in for SupabaseOrgRepository against whatever DATABASE_URL
// points at. Implements the same OrgRepository interface so the
// application service is unchanged.

@Injectable()
export class DrizzleOrgRepository implements OrgRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(context: ActorContext, input: CreateOrgRecord): Promise<OrgSummaryRecord> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    // Insert org + owner membership in a single transaction so a
    // membership-write failure rolls back the org create.
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(orgs)
        .values({ slug: input.slug, name: input.name, createdBy: userId })
        .returning()
        .catch((err: Error) => {
          if (/duplicate key value/.test(err.message)) {
            throw new ValidationDomainError("org slug already exists");
          }
          throw new ValidationDomainError(err.message);
        });
      if (!created) throw new ValidationDomainError("org create failed");

      await tx
        .insert(orgMembers)
        .values({ orgId: created.id, userId, role: "owner" });

      return {
        id: created.id,
        slug: created.slug,
        name: created.name,
        plan: created.plan,
        role: "owner",
        joinedAt: this.iso(created.createdAt),
      };
    });
  }

  async listMine(context: ActorContext): Promise<OrgSummaryRecord[]> {
    const userId = context.principal.userId;
    if (!userId) return [];
    const rows = await this.db
      .select({
        id: orgs.id,
        slug: orgs.slug,
        name: orgs.name,
        plan: orgs.plan,
        role: orgMembers.role,
        joinedAt: orgMembers.joinedAt,
      })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, userId))
      .orderBy(asc(orgMembers.joinedAt));
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      plan: r.plan,
      role: r.role as OrgSummaryRecord["role"],
      joinedAt: this.iso(r.joinedAt),
    }));
  }

  async findBySlug(context: ActorContext, slug: string): Promise<OrgDetailRecord | null> {
    const orgRow = await this.db.query.orgs.findFirst({ where: eq(orgs.slug, slug) });
    if (!orgRow) return null;

    const userId = context.principal.userId ?? "";
    const member = await this.db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, orgRow.id), eq(orgMembers.userId, userId)),
    });
    if (!member) return null;

    return {
      id: orgRow.id,
      slug: orgRow.slug,
      name: orgRow.name,
      plan: orgRow.plan,
      // orgs.updated_at doesn't exist in the schema yet — reuse created_at
      // until a follow-up migration adds the column.
      createdAt: this.iso(orgRow.createdAt),
      updatedAt: this.iso(orgRow.createdAt),
      viewerRole: member.role as OrgSummaryRecord["role"],
    };
  }

  async listMembers(_context: ActorContext, orgId: string): Promise<OrgMemberRecord[]> {
    const rows = await this.db
      .select({
        userId: orgMembers.userId,
        role: orgMembers.role,
        joinedAt: orgMembers.joinedAt,
        email: profiles.email,
        displayName: profiles.displayName,
      })
      .from(orgMembers)
      .leftJoin(profiles, eq(profiles.userId, orgMembers.userId))
      .where(eq(orgMembers.orgId, orgId))
      .orderBy(asc(orgMembers.joinedAt));
    return rows.map((r) => ({
      userId: r.userId,
      role: r.role as OrgMemberRecord["role"],
      joinedAt: this.iso(r.joinedAt),
      email: r.email,
      displayName: r.displayName,
      // profiles.avatar_url doesn't exist yet; users.avatar_url does
      // but isn't joined here. Returning null matches the legacy shape
      // when the join was empty.
      avatarUrl: null,
    }));
  }

  async findIdBySlug(_context: ActorContext, slug: string): Promise<string | null> {
    const row = await this.db.query.orgs.findFirst({ where: eq(orgs.slug, slug) });
    return row?.id ?? null;
  }

  private iso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d);
  }
}
