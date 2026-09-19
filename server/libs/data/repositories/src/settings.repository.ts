import type { ActorContext } from "@openkt/core-context";

export interface SettingsRecord {
  settings: Record<string, unknown>;
  updatedAt: string;
}

export interface SettingsRepository {
  getUser(context: ActorContext): Promise<SettingsRecord>;
  updateUser(context: ActorContext, settings: Record<string, unknown>): Promise<SettingsRecord>;
  getProject(context: ActorContext, projectId: string): Promise<SettingsRecord>;
  updateProject(
    context: ActorContext,
    projectId: string,
    settings: Record<string, unknown>,
  ): Promise<SettingsRecord>;
  getOrg(context: ActorContext, orgId: string): Promise<SettingsRecord>;
  updateOrg(
    context: ActorContext,
    orgId: string,
    settings: Record<string, unknown>,
  ): Promise<SettingsRecord>;
}
