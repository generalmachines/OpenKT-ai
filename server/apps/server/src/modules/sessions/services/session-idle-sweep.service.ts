import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { JobQueueRepository } from "../../jobs/repositories/job-queue.repository";
import { SessionRepository } from "../repositories/session.repository";
import { MIN_SESSION_CHARS } from "./sessions-application.service";

// Idle-close sweep — M1 "Sessions" (architecture.md §4: "Idle sessions
// close themselves"). Runs a plain `setInterval` (same pattern as
// apps/worker's DailyRollupService — there is
// no @nestjs/schedule in this codebase yet) that closes any `open`
// session whose `last_activity_at` is older than the idle threshold.
//
// Lives in the server app rather than the worker: sessions are a
// DRIZZLE-backed, request-path concept (unlike the worker's
// RabbitMQ/SQS pipeline stages), and the server already boots one
// process per instance — a second interval here costs nothing extra
// and keeps the whole session lifecycle in one app.
const TICK_MS = 60_000; // check every minute
const DEFAULT_IDLE_MINUTES = 30;

@Injectable()
export class SessionIdleSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionIdleSweepService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly configService: ConfigService,
    private readonly jobQueue: JobQueueRepository,
  ) {}

  onModuleInit(): void {
    if (this.configService.get<string>("OPENKT_DISABLE_SESSION_SWEEP") === "1") {
      this.logger.log("session idle-close sweep disabled by env");
      return;
    }
    this.timer = setInterval(() => void this.runSafe(), TICK_MS);
    // Node timers keep the event loop (and therefore serverless/CI
    // shutdown) alive; unref so the sweep never blocks a clean exit.
    this.timer.unref?.();
    this.logger.log(
      `session idle-close sweep scheduled (every ${TICK_MS / 1000}s, idle_minutes=${this.idleMinutes()})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private idleMinutes(): number {
    const raw = this.configService.get<string>("OPENKT_SESSION_IDLE_MINUTES");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MINUTES;
  }

  private async runSafe(): Promise<void> {
    try {
      const closed = await this.sessionRepository.closeIdleSessions(this.idleMinutes());
      if (closed.length > 0) {
        this.logger.log(`idle-closed ${closed.length} session(s): ${closed.join(", ")}`);
      }
      // A session closed for being idle is processed like one closed on purpose.
      for (const id of closed) await this.jobQueue.enqueueSessionOnce(id, MIN_SESSION_CHARS);
    } catch (err) {
      this.logger.error(
        `session idle sweep tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
