import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";

import { CronController } from "../../apps/server/src/modules/internal/controllers/cron.controller";

// Tests the auth gating + Drizzle plumbing on the archive-stale entrypoint.
// The SQL itself is mocked here; live DB behavior is covered by migration
// and smoke tests.

const buildCron = (
  cronSecret: string | undefined,
  executeImpl: jest.Mock,
): CronController => {
  const config = {
    get: jest.fn((key: string) => (key === "CRON_SECRET" ? cronSecret : undefined)),
  } as never;
  const db = { execute: executeImpl } as never;
  return new CronController(config, db);
};

describe("CronController.archiveStale", () => {
  it("returns 503 when CRON_SECRET is unconfigured (fail-closed)", async () => {
    const execute = jest.fn();
    const cron = buildCron(undefined, execute);
    await expect(cron.archiveStale("Bearer anything", undefined, {})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects with 403 when neither header carries the secret", async () => {
    const execute = jest.fn();
    const cron = buildCron("hunter2", execute);
    await expect(cron.archiveStale(undefined, undefined, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(cron.archiveStale("Bearer wrong", "wrong", {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts the secret via Authorization: Bearer", async () => {
    const execute = jest.fn().mockResolvedValue({
      rows: [
        { archived_id: "m1", org_id: "o1", project_id: "p1" },
        { archived_id: "m2", org_id: "o1", project_id: "p1" },
      ],
    });
    const cron = buildCron("hunter2", execute);
    const response = (await cron.archiveStale("Bearer hunter2", undefined, {})) as {
      data: { archived_count: number; archived_ids: string[]; scope_org_id: string | null };
    };
    expect(response.data.archived_count).toBe(2);
    expect(response.data.archived_ids).toEqual(["m1", "m2"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("accepts the secret via x-cron-secret header", async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [] });
    const cron = buildCron("hunter2", execute);
    const response = (await cron.archiveStale(undefined, "hunter2", {})) as {
      data: { archived_count: number };
    };
    expect(response.data.archived_count).toBe(0);
  });

  it("accepts explicit body fields", async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [] });
    const cron = buildCron("hunter2", execute);
    // v4 UUID — zod 4 enforces version + variant bits, not just shape.
    const orgId = "11111111-1111-4111-8111-111111111111";
    await cron.archiveStale(
      "Bearer hunter2",
      undefined,
      { scope_org_id: orgId, max_rows: 50 },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates database errors as 500-shaped throws", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("permission denied"));
    const cron = buildCron("hunter2", execute);
    await expect(cron.archiveStale("Bearer hunter2", undefined, {})).rejects.toThrow(
      /permission denied/,
    );
  });
});
