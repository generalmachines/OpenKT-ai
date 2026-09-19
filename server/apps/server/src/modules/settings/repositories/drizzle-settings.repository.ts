import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";
import type {
  SettingsRecord,
  SettingsRepository,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  orgSettings,
  projectSettings,
  userSettings,
} from "../../../db/schema";

// Three-table settings store. Each row is a flat JSONB blob. The
// application service is what shapes individual keys; this repo just
// upserts the blob.

@Injectable()
export class DrizzleSettingsRepository implements SettingsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getUser(context: ActorContext): Promise<SettingsRecord> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");
    const row = await this.db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    });
    return this.toRecord(row?.data, row?.updatedAt);
  }

  async updateUser(
    context: ActorContext,
    settings: Record<string, unknown>,
  ): Promise<SettingsRecord> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");
    const [row] = await this.db
      .insert(userSettings)
      .values({ userId, data: settings })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { data: settings, updatedAt: new Date() },
      })
      .returning();
    return this.toRecord(row?.data, row?.updatedAt);
  }

  async getProject(_context: ActorContext, projectId: string): Promise<SettingsRecord> {
    const row = await this.db.query.projectSettings.findFirst({
      where: eq(projectSettings.projectId, projectId),
    });
    return this.toRecord(row?.data, row?.updatedAt);
  }

  async updateProject(
    _context: ActorContext,
    projectId: string,
    settings: Record<string, unknown>,
  ): Promise<SettingsRecord> {
    const [row] = await this.db
      .insert(projectSettings)
      .values({ projectId, data: settings })
      .onConflictDoUpdate({
        target: projectSettings.projectId,
        set: { data: settings, updatedAt: new Date() },
      })
      .returning();
    return this.toRecord(row?.data, row?.updatedAt);
  }

  async getOrg(_context: ActorContext, orgId: string): Promise<SettingsRecord> {
    const row = await this.db.query.orgSettings.findFirst({
      where: eq(orgSettings.orgId, orgId),
    });
    return this.toRecord(row?.data, row?.updatedAt);
  }

  async updateOrg(
    _context: ActorContext,
    orgId: string,
    settings: Record<string, unknown>,
  ): Promise<SettingsRecord> {
    const [row] = await this.db
      .insert(orgSettings)
      .values({ orgId, data: settings })
      .onConflictDoUpdate({
        target: orgSettings.orgId,
        set: { data: settings, updatedAt: new Date() },
      })
      .returning();
    return this.toRecord(row?.data, row?.updatedAt);
  }

  private toRecord(data: unknown, updatedAt: Date | undefined): SettingsRecord {
    return {
      settings: (data as Record<string, unknown>) ?? {},
      updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : new Date(0).toISOString(),
    };
  }
}
