import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import type {
  SecretMetadataRecord,
  SecretRepository,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { orgSecrets } from "../../../db/schema";

// Returns metadata only — never the ciphertext. The legacy Supabase
// path read from a `org_secrets_public` view that did this masking;
// here it's a SELECT projection.

@Injectable()
export class DrizzleSecretRepository implements SecretRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async listOrgSecretMetadata(
    _context: ActorContext,
    orgId: string,
  ): Promise<SecretMetadataRecord[]> {
    const rows = await this.db
      .select({
        id: orgSecrets.id,
        label: orgSecrets.label,
        createdAt: orgSecrets.createdAt,
        updatedAt: orgSecrets.updatedAt,
      })
      .from(orgSecrets)
      .where(eq(orgSecrets.orgId, orgId))
      .orderBy(asc(orgSecrets.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.label,
      description: null,
      maskedPreview: null,
      lastRotatedAt: this.iso(r.updatedAt),
      createdAt: this.iso(r.createdAt),
      updatedAt: this.iso(r.updatedAt),
    }));
  }

  private iso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d);
  }
}
