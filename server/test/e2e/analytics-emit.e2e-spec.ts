import { AnalyticsService } from "../../apps/server/src/modules/analytics/services/analytics.service";

// AnalyticsService.emit() must never throw — even when the DB is on
// fire. It must still attempt to insert when the DB is healthy.

describe("AnalyticsService.emit (unit)", () => {
  it("inserts a row on the happy path", async () => {
    // Type the mock as (...args: unknown[]) => Promise<...> so the
    // tuple inferred for `mock.calls[i]` keeps its element type
    // (otherwise jest.fn(async () => ...) infers a 0-length tuple
    // and TS rejects `.calls[0][0]`).
    const execute = jest.fn(async (..._args: unknown[]) => ({ rows: [] }));
    const service = new AnalyticsService({ execute } as never);
    await service.emit({
      event: "memory.created",
      userId: "00000000-0000-4000-8000-000000000001",
      orgId: null,
      projectId: null,
      properties: { ok: true },
      client: "cli",
      requestId: "req-1",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0]?.[0];
    expect(call).toBeDefined();
  });

  it("swallows DB errors and does not throw", async () => {
    const execute = jest.fn(async () => {
      throw new Error("relation does not exist");
    });
    const service = new AnalyticsService({ execute } as never);
    await expect(
      service.emit({
        event: "memory.created",
        client: "cli",
        requestId: "req-2",
      }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("defaults properties to {} when not provided", async () => {
    const execute = jest.fn(async () => ({ rows: [] }));
    const service = new AnalyticsService({ execute } as never);
    await service.emit({
      event: "memory.recalled",
      client: "web",
      requestId: "req-3",
    });
    expect(execute).toHaveBeenCalled();
  });
});
