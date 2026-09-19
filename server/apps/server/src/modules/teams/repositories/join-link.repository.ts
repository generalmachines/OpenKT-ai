import { randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { joinLinks, profiles, projects, type JoinLink } from "../../../db/schema";
import type { JoinRole } from "../contracts/join-link.contract";

const CODE_LENGTH = 10;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 10 characters from 62 (about 59 bits), without modulo bias.
export function newJoinCode(): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && out.length < CODE_LENGTH) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

// A link works while it has not expired and has uses left.
const usable = sql`(${joinLinks.expiresAt} is null or ${joinLinks.expiresAt} > now())
  and (${joinLinks.maxUses} is null or ${joinLinks.uses} < ${joinLinks.maxUses})`;

export interface FoundLink {
  link: JoinLink;
  spaceName: string;
  inviterName: string | null;
  // Not expired and not used up.
  usable: boolean;
}

@Injectable()
export class JoinLinkRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(input: {
    projectId: string;
    role: JoinRole;
    createdBy: string;
    expiresAt: Date | null;
    maxUses: number | null;
  }): Promise<JoinLink> {
    // A collision in 59 bits is not going to happen, but retrying is cheap.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [row] = await this.db
        .insert(joinLinks)
        .values({ code: newJoinCode(), ...input })
        .onConflictDoNothing()
        .returning();
      if (row) return row;
    }
    throw new Error("could not create a join link");
  }

  async listForProject(projectId: string): Promise<JoinLink[]> {
    return this.db
      .select()
      .from(joinLinks)
      .where(eq(joinLinks.projectId, projectId))
      .orderBy(desc(joinLinks.createdAt));
  }

  // An unlimited, still-valid link this person already made for this space
  // and role — so asking for "the invite link" twice returns the same one.
  async findReusable(projectId: string, createdBy: string, role: JoinRole): Promise<JoinLink | null> {
    const [row] = await this.db
      .select()
      .from(joinLinks)
      .where(
        and(
          eq(joinLinks.projectId, projectId),
          eq(joinLinks.createdBy, createdBy),
          eq(joinLinks.role, role),
          isNull(joinLinks.maxUses),
          sql`(${joinLinks.expiresAt} is null or ${joinLinks.expiresAt} > now() + interval '1 day')`,
        ),
      )
      .orderBy(desc(joinLinks.createdAt))
      .limit(1);
    return row ?? null;
  }

  async remove(projectId: string, code: string): Promise<boolean> {
    const rows = await this.db
      .delete(joinLinks)
      .where(and(eq(joinLinks.projectId, projectId), eq(joinLinks.code, code)))
      .returning({ code: joinLinks.code });
    return rows.length > 0;
  }

  // The link with its space's name and the display name of whoever made it,
  // or null when there is no such link (or it was deleted).
  async find(code: string): Promise<FoundLink | null> {
    const [row] = await this.db
      .select({
        link: joinLinks,
        spaceName: projects.name,
        inviterName: profiles.displayName,
        usable: sql<boolean>`${usable}`,
      })
      .from(joinLinks)
      .innerJoin(projects, eq(projects.id, joinLinks.projectId))
      .leftJoin(profiles, eq(profiles.userId, joinLinks.createdBy))
      .where(eq(joinLinks.code, code))
      .limit(1);
    return row ?? null;
  }

  // Uses one join, atomically: false when the link ran out (or expired) in
  // the meantime.
  async claim(code: string): Promise<boolean> {
    const rows = await this.db
      .update(joinLinks)
      .set({ uses: sql`${joinLinks.uses} + 1` })
      .where(and(eq(joinLinks.code, code), usable))
      .returning({ code: joinLinks.code });
    return rows.length > 0;
  }
}

export function isUsable(link: JoinLink, now = new Date()): boolean {
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return false;
  if (link.maxUses !== null && link.uses >= link.maxUses) return false;
  return true;
}
