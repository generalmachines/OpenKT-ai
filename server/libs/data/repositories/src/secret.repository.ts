import type { ActorContext } from "@openkt/core-context";

export interface SecretMetadataRecord {
  id: string;
  name: string;
  description: string | null;
  maskedPreview: string | null;
  lastRotatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRepository {
  listOrgSecretMetadata(
    context: ActorContext,
    orgId: string,
  ): Promise<SecretMetadataRecord[]>;
}
