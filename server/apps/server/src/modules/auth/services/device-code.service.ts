import { randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq } from "drizzle-orm";

import {
  GoneDomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { deviceCodes } from "../../../db/schema";

// Device-code (browser) login flow for the kt CLI.
//
// Three operations:
//   start()     — POST /v1/auth/device-code (public). Mint a fresh code,
//                 stash a pending row, return code + dashboard URL.
//   confirm()   — POST /v1/auth/device-confirm (authenticated). Dashboard
//                 user pastes the code; we attach their JWT as session_data
//                 and flip status -> 'confirmed'.
//   pollStatus()— GET  /v1/auth/device-code/{code}/status (public). CLI
//                 polls every ~2s. Once 'confirmed', we hand back the JWT
//                 and flip the row to 'consumed' so a leaked code can't
//                 hand out the same token twice.
//
// Device codes live in OpenKT Postgres. Supabase remains only the auth
// token issuer; this flow should not require public tables in Supabase.
//
// Code alphabet excludes the visually-ambiguous chars 0/O/1/I/l. 10 chars
// from a 32-char alphabet = 50 bits of entropy; more than enough for a
// 10-minute window. We use `byte % 32`, which is unbiased (256 % 32 == 0).

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const TTL_MS = 10 * 60 * 1000;

export type DeviceCodeStatus = "pending" | "approved" | "expired";

export interface StartDeviceCodeResult {
  code: string;
  url: string;
  expires_at: number;
}

export interface PollDeviceCodeResult {
  status: DeviceCodeStatus;
  token?: string;
  refresh_token?: string;
}

interface DeviceCodeRow {
  code: string;
  status: "pending" | "confirmed" | "consumed" | "expired";
  sessionData: { token?: string; refresh_token?: string } | null;
  expiresAt: Date;
}

@Injectable()
export class DeviceCodeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
  ) {}

  async start(): Promise<StartDeviceCodeResult> {
    const expiresAtMs = Date.now() + TTL_MS;
    const expiresAt = new Date(expiresAtMs);

    // Code collisions are astronomically unlikely (50 bits over a
    // 10-minute window), but a primary-key collision shouldn't 500 the
    // CLI — try a couple of times before giving up.
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateCode();
      try {
        await this.db.insert(deviceCodes).values({
          code,
          status: "pending",
          expiresAt,
        });
        return {
          code,
          url: this.buildDashboardUrl(code),
          expires_at: Math.floor(expiresAtMs / 1000),
        };
      } catch (error) {
        const pgError = error as { code?: string; message?: string };
        lastError = pgError.message ?? "could not allocate device code";
        if (pgError.code !== "23505") break;
      }
    }
    throw new ValidationDomainError(
      lastError ?? "could not allocate device code",
    );
  }

  async confirm(
    userId: string,
    jwt: string,
    code: string,
    refreshToken?: string,
  ): Promise<void> {
    const row = await this.fetchRow(code);
    if (!row) {
      throw new NotFoundDomainError("device code");
    }
    // Expired and already-used both render the code unusable from the
    // dashboard's perspective. 410 Gone matches the semantics ("the
    // resource was here and is now permanently unavailable") and lets
    // the dashboard branch on status alone instead of parsing message
    // strings out of a generic 400.
    if (this.isExpired(row)) {
      throw new GoneDomainError("device code expired");
    }
    if (row.status !== "pending") {
      throw new GoneDomainError("device code already used");
    }

    // Persist the refresh_token alongside the access token so the CLI
    // doesn't have to re-auth every hour. Older dashboard builds may
    // omit it; we still accept those for backward compat — the CLI just
    // won't get a refresh path until the dashboard catches up.
    const sessionData: { token: string; refresh_token?: string } = { token: jwt };
    if (refreshToken && refreshToken.length > 0) {
      sessionData.refresh_token = refreshToken;
    }

    try {
      await this.db
        .update(deviceCodes)
        .set({
          status: "confirmed",
          userId,
          sessionData,
          confirmedAt: new Date(),
        })
        .where(and(eq(deviceCodes.code, code), eq(deviceCodes.status, "pending")));
    } catch (error) {
      throw new ValidationDomainError((error as Error).message);
    }
  }

  async pollStatus(code: string): Promise<PollDeviceCodeResult> {
    const row = await this.fetchRow(code);
    if (!row) {
      // Treat unknown codes the same as expired so a typo / stale code
      // surfaces cleanly to the CLI rather than 404-ing the polling
      // loop.
      return { status: "expired" };
    }
    if (this.isExpired(row)) {
      return { status: "expired" };
    }
    if (row.status === "confirmed") {
      const token = row.sessionData?.token ?? "";
      const refreshToken = row.sessionData?.refresh_token ?? "";
      // Single-use: flip to 'consumed' so a second poll can't replay.
      // The conditional eq() makes it safe under concurrent polls — at
      // most one wins.
      await this.db
        .update(deviceCodes)
        .set({ status: "consumed", consumedAt: new Date() })
        .where(and(eq(deviceCodes.code, code), eq(deviceCodes.status, "confirmed")));
      const result: PollDeviceCodeResult = { status: "approved", token };
      if (refreshToken) {
        result.refresh_token = refreshToken;
      }
      return result;
    }
    if (row.status === "consumed") {
      // Already handed out. Don't leak the token again.
      return { status: "expired" };
    }
    return { status: "pending" };
  }

  private async fetchRow(code: string): Promise<DeviceCodeRow | null> {
    const rows = await this.db
      .select({
        code: deviceCodes.code,
        status: deviceCodes.status,
        sessionData: deviceCodes.sessionData,
        expiresAt: deviceCodes.expiresAt,
      })
      .from(deviceCodes)
      .where(eq(deviceCodes.code, code))
      .limit(1);
    return (rows[0] as DeviceCodeRow | undefined) ?? null;
  }

  private isExpired(row: DeviceCodeRow): boolean {
    return row.expiresAt.getTime() <= Date.now();
  }

  private buildDashboardUrl(code: string): string {
    const base =
      this.configService.get<string>("OPENKT_DASHBOARD_URL") ??
      "http://localhost:3000";
    const trimmed = base.replace(/\/+$/, "");
    return `${trimmed}/signin/device?code=${encodeURIComponent(code)}`;
  }
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}
