import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  PROFILE_REPOSITORY,
  type ProfileRepository,
  type UpdateProfileRecord,
} from "@openkt/data-repositories";
import { NotFoundDomainError } from "@openkt/core-errors";

@Injectable()
export class ProfileApplicationService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profileRepository: ProfileRepository,
  ) {}

  // The repository lazy-creates the row on cold-start for user principals,
  // so the only path that ever returns null here is a non-user principal
  // reaching the /v1/profile/me surface — which the guard already rejects.
  // The NotFound is kept as a defence-in-depth check so a misconfigured
  // guard can't leak a null body to the client.
  async getMe(context: ActorContext) {
    const profile = await this.profileRepository.getMe(context);
    if (!profile) {
      throw new NotFoundDomainError("profile");
    }
    return profile;
  }

  updateMe(context: ActorContext, input: UpdateProfileRecord) {
    return this.profileRepository.updateMe(context, input);
  }
}
