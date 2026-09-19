import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { orgInvites } from "../../../db/schema/org-invites";
import { waitlist, type WaitlistRow } from "../../../db/schema/waitlist";

export interface WaitlistJoinInput {
  email: string;
  source?: string | null;
  note?: string | null;
  useCase?: string | null;
  referrer?: string | null;
}

export interface SignupEligibility {
  allowed: boolean;
  reason: "approved" | "invite" | "denied" | "pending" | "unknown";
  detail: string | null;
}

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Anyone can join. Idempotent on email — second submit just refreshes
  // metadata fields, never resurrects an already-denied row. Returns
  // the row's status so the public endpoint can echo a useful message.
  async join(input: WaitlistJoinInput): Promise<WaitlistRow> {
    const email = normalizeEmail(input.email);
    const existing = await this.findByEmail(email);
    if (existing) {
      const dirty: Partial<WaitlistRow> = {};
      if (input.source && input.source !== existing.source) {
        dirty.source = input.source;
      }
      if (input.note && input.note !== existing.note) {
        dirty.note = input.note;
      }
      if (input.useCase && input.useCase !== existing.useCase) {
        dirty.useCase = input.useCase;
      }
      if (input.referrer && input.referrer !== existing.referrer) {
        dirty.referrer = input.referrer;
      }
      if (Object.keys(dirty).length === 0) return existing;
      const [row] = await this.db
        .update(waitlist)
        .set(dirty)
        .where(eq(waitlist.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await this.db
      .insert(waitlist)
      .values({
        email,
        source: input.source ?? null,
        note: input.note ?? null,
        useCase: input.useCase ?? null,
        referrer: input.referrer ?? null,
      })
      .returning();
    this.logger.log(
      `[waitlist] joined ${email} source=${input.source ?? "unknown"}`,
    );
    return row;
  }

  async listPending(limit = 100): Promise<WaitlistRow[]> {
    return this.db
      .select()
      .from(waitlist)
      .where(and(isNull(waitlist.approvedAt), isNull(waitlist.deniedAt)))
      .orderBy(desc(waitlist.requestedAt))
      .limit(limit);
  }

  async listApproved(limit = 100): Promise<WaitlistRow[]> {
    return this.db
      .select()
      .from(waitlist)
      .where(isNotNull(waitlist.approvedAt))
      .orderBy(desc(waitlist.approvedAt))
      .limit(limit);
  }

  async listAll(limit = 200): Promise<WaitlistRow[]> {
    return this.db
      .select()
      .from(waitlist)
      .orderBy(desc(waitlist.requestedAt))
      .limit(limit);
  }

  async approve(id: string, approvedBy: string): Promise<WaitlistRow> {
    const existing = await this.requireById(id);
    if (existing.approvedAt) return existing;
    if (existing.deniedAt) {
      throw new ValidationDomainError(
        "Cannot approve a denied waitlist entry; reset denied_at first.",
      );
    }
    const [row] = await this.db
      .update(waitlist)
      .set({
        approvedAt: sql`now()`,
        approvedBy,
      })
      .where(eq(waitlist.id, id))
      .returning();
    this.logger.log(`[waitlist] approved ${row.email} by=${approvedBy}`);
    return row;
  }

  async deny(id: string, reason: string | null): Promise<WaitlistRow> {
    const existing = await this.requireById(id);
    if (existing.deniedAt) return existing;
    const [row] = await this.db
      .update(waitlist)
      .set({
        deniedAt: sql`now()`,
        deniedReason: reason,
      })
      .where(eq(waitlist.id, id))
      .returning();
    this.logger.log(
      `[waitlist] denied ${row.email} reason=${reason ?? "unspecified"}`,
    );
    return row;
  }

  // Called from AuthApplicationService.signup. Returns the reason a
  // signup is or isn't allowed so the caller can surface it to the user.
  //
  // Gate policy (2026-05-16): public signup is OPEN by default. The
  // waitlist still exists for tracking + admin denylisting, but a row's
  // ABSENCE no longer blocks. The only block is an explicit deniedAt
  // row (set by admin via /v1/waitlist/admin/:id/deny).
  //
  // To restore closed-beta behavior, set env `SIGNUP_REQUIRE_WAITLIST=1`.
  // Then absence-of-row → denied, matching the prior contract.
  async checkSignupEligibility(email: string): Promise<SignupEligibility> {
    const normalized = normalizeEmail(email);
    const row = await this.findByEmail(normalized);

    if (row?.deniedAt) {
      return {
        allowed: false,
        reason: "denied",
        detail: row.deniedReason ?? "Your access request was declined.",
      };
    }
    if (row?.approvedAt) {
      return {
        allowed: true,
        reason: "approved",
        detail: `Approved on ${row.approvedAt.toISOString()}`,
      };
    }

    // Pending org invite for this email is also a green light — the org
    // owner has explicitly invited them, no need to re-approve. Wrapped
    // in try/catch because in environments where migration 0030 hasn't
    // run yet the `org_invites` table can be missing (Postgres error
    // code 42P01 = undefined_table). A missing invite table just means
    // "no invites" — don't fail the signup over it.
    let inviteFound = false;
    try {
      const invite = await this.db
        .select({ id: orgInvites.id })
        .from(orgInvites)
        .where(
          and(
            eq(sql`lower(${orgInvites.email})`, normalized),
            isNull(orgInvites.acceptedAt),
          ),
        )
        .limit(1);
      inviteFound = invite.length > 0;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "42P01") throw err;
      this.logger.warn(
        "[waitlist] org_invites table not present; skipping invite-gate check",
      );
    }
    if (inviteFound) {
      return {
        allowed: true,
        reason: "invite",
        detail: "Pre-approved via pending org invite",
      };
    }

    // Closed-beta override: when SIGNUP_REQUIRE_WAITLIST=1, absence of an
    // approved row blocks (the historic contract pre-2026-05-16). Default
    // is open so a public launch isn't gated behind admin approval. Truthy
    // values: "1", "true", "yes". Anything else = open.
    const requireWaitlist = ["1", "true", "yes"].includes(
      (process.env.SIGNUP_REQUIRE_WAITLIST ?? "").toLowerCase(),
    );
    if (requireWaitlist) {
      if (row) {
        return {
          allowed: false,
          reason: "pending",
          detail: "Your waitlist request is still under review.",
        };
      }
      return {
        allowed: false,
        reason: "unknown",
        detail: "Email not on the beta waitlist. Join at https://openkt.ai.",
      };
    }

    // Default: open signup. No row + no denial = welcome.
    return {
      allowed: true,
      reason: row ? "pending" : "unknown",
      detail: null,
    };
  }

  // Called from AuthApplicationService.signup AFTER Supabase Auth has
  // successfully created the user. Marks the waitlist row as redeemed
  // so the admin UI shows who actually signed up.
  async markSignedUp(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    await this.db
      .update(waitlist)
      .set({ signedUpAt: sql`now()` })
      .where(
        and(
          eq(sql`lower(${waitlist.email})`, normalized),
          isNull(waitlist.signedUpAt),
        ),
      );
  }

  private async findByEmail(email: string): Promise<WaitlistRow | null> {
    const rows = await this.db
      .select()
      .from(waitlist)
      .where(eq(sql`lower(${waitlist.email})`, email))
      .limit(1);
    return rows[0] ?? null;
  }

  private async requireById(id: string): Promise<WaitlistRow> {
    if (!isUuid(id)) {
      throw new ValidationDomainError("Not a UUID");
    }
    const rows = await this.db
      .select()
      .from(waitlist)
      .where(eq(waitlist.id, id))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundDomainError(`No waitlist row ${id}`);
    }
    return rows[0];
  }
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
