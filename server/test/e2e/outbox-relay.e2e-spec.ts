import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";

import {
  MEMORY_COMMANDS_EXCHANGE,
  MESSAGE_QUEUE_PUBLISHER,
} from "../../apps/worker/src/modules/mq/mq.constants";
import {
  type ClaimedOutboxEvent,
  OUTBOX_RELAY_STORE,
} from "../../apps/worker/src/modules/outbox/outbox.constants";
import { OutboxRelayService } from "../../apps/worker/src/modules/outbox/outbox-relay.service";

const MEMORY_ID = "00000000-0000-0000-0000-0000000000ab";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000cd";
const USER_ID = "00000000-0000-0000-0000-0000000000ef";
const ORG_ID = "00000000-0000-0000-0000-000000000111";
const OUTBOX_ID = "00000000-0000-0000-0000-000000000222";
const CLAIM_TOKEN = "00000000-0000-0000-0000-000000000333";

function baseEvent(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    id: OUTBOX_ID,
    aggregateType: "memory",
    aggregateId: MEMORY_ID,
    eventType: "memory.created",
    payload: {
      project_id: PROJECT_ID,
      org_id: ORG_ID,
      owner_user_id: USER_ID,
      created_at: "2026-04-29T00:00:00.000Z",
      updated_at: "2026-04-29T00:00:01.000Z",
    },
    publishedAt: null,
    attempts: 0,
    lastError: null,
    createdAt: "2026-04-29T00:00:00.000Z",
    nextAttemptAt: "2026-04-29T00:00:00.000Z",
    claimToken: CLAIM_TOKEN,
    claimedAt: "2026-04-29T00:00:02.000Z",
    ...overrides,
  };
}

describe("OutboxRelayService (Track C.2 e2e)", () => {
  let moduleRef: TestingModule;
  let relay: OutboxRelayService;

  const outboxStoreMock = {
    claimBatch: jest.fn<Promise<ClaimedOutboxEvent[]>, [number, number]>(),
    markPublished: jest.fn<Promise<boolean>, [string, string, string]>(),
    markFailed: jest.fn<Promise<boolean>, [string, string, string, string]>(),
  };

  const publisherMock = {
    publish: jest.fn<Promise<void>, [string, string, unknown, unknown]>(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    moduleRef = await Test.createTestingModule({
      providers: [
        OutboxRelayService,
        {
          provide: OUTBOX_RELAY_STORE,
          useValue: outboxStoreMock,
        },
        {
          provide: MESSAGE_QUEUE_PUBLISHER,
          useValue: publisherMock,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const values: Record<string, unknown> = {
                NODE_ENV: "test",
                OUTBOX_RELAY_BATCH_SIZE: 50,
                OUTBOX_RELAY_ACTIVE_POLL_MS: 250,
                OUTBOX_RELAY_IDLE_POLL_MS: 5000,
                OUTBOX_RELAY_CLAIM_TTL_SECONDS: 30,
                OUTBOX_RELAY_RETRY_BASE_MS: 1000,
                OUTBOX_RELAY_RETRY_MAX_MS: 60000,
              };
              return values[key];
            }),
          },
        },
      ],
    }).compile();

    relay = moduleRef.get(OutboxRelayService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it("publishes memory.created to the commands exchange and stamps only after confirm", async () => {
    outboxStoreMock.claimBatch.mockResolvedValue([baseEvent()]);
    publisherMock.publish.mockResolvedValue(undefined);
    outboxStoreMock.markPublished.mockResolvedValue(true);

    const processed = await relay.drainOnce();

    expect(processed).toBe(1);
    expect(outboxStoreMock.claimBatch).toHaveBeenCalledWith(50, 30);
    expect(publisherMock.publish).toHaveBeenCalledTimes(1);
    expect(publisherMock.publish).toHaveBeenCalledWith(
      MEMORY_COMMANDS_EXCHANGE,
      // The relay publishes to the static `memory.preprocess.request`
      // routing key — the topic exchange + queue binding wildcard
      // collect every routing key onto the single command queue, so
      // we don't need a per-aggregate key here.
      "memory.preprocess.request",
      expect.objectContaining({
        message_id: OUTBOX_ID,
        correlation_id: OUTBOX_ID,
        job_type: "memory.preprocess",
        aggregate_type: "memory",
        aggregate_id: MEMORY_ID,
        project_id: PROJECT_ID,
        org_id: ORG_ID,
        user_id: USER_ID,
        version_token: "2026-04-29T00:00:01.000Z",
        payload: expect.objectContaining({
          source_event_type: "memory.created",
        }),
      }),
      expect.objectContaining({
        messageId: OUTBOX_ID,
      }),
    );

    const publishedMessage = publisherMock.publish.mock.calls[0]?.[2] as {
      published_at: string;
    };
    expect(outboxStoreMock.markPublished).toHaveBeenCalledWith(
      OUTBOX_ID,
      CLAIM_TOKEN,
      publishedMessage.published_at,
    );
    expect(outboxStoreMock.markFailed).not.toHaveBeenCalled();
  });

  it("leaves published_at null and records failure metadata on publish reject", async () => {
    outboxStoreMock.claimBatch.mockResolvedValue([baseEvent({ attempts: 2 })]);
    publisherMock.publish.mockRejectedValue(new Error("broker unavailable"));
    outboxStoreMock.markFailed.mockResolvedValue(true);

    const processed = await relay.drainOnce();

    expect(processed).toBe(1);
    expect(outboxStoreMock.markPublished).not.toHaveBeenCalled();
    expect(outboxStoreMock.markFailed).toHaveBeenCalledTimes(1);
    expect(outboxStoreMock.markFailed).toHaveBeenCalledWith(
      OUTBOX_ID,
      CLAIM_TOKEN,
      "broker unavailable",
      expect.any(String),
    );

    const nextAttemptAt = outboxStoreMock.markFailed.mock.calls[0]?.[3] as string;
    expect(Date.parse(nextAttemptAt)).toBeGreaterThan(Date.now() - 1_000);
  });

  it("skips rows that are already published", async () => {
    outboxStoreMock.claimBatch.mockResolvedValue([
      baseEvent({ publishedAt: "2026-04-29T00:10:00.000Z" }),
    ]);

    const processed = await relay.drainOnce();

    expect(processed).toBe(0);
    expect(publisherMock.publish).not.toHaveBeenCalled();
    expect(outboxStoreMock.markPublished).not.toHaveBeenCalled();
    expect(outboxStoreMock.markFailed).not.toHaveBeenCalled();
  });

  it("marks unsupported outbox event types as failed instead of leaking the claim", async () => {
    outboxStoreMock.claimBatch.mockResolvedValue([
      baseEvent({ eventType: "memory.deleted" }),
    ]);
    outboxStoreMock.markFailed.mockResolvedValue(true);

    const processed = await relay.drainOnce();

    expect(processed).toBe(1);
    expect(publisherMock.publish).not.toHaveBeenCalled();
    expect(outboxStoreMock.markFailed).toHaveBeenCalledWith(
      OUTBOX_ID,
      CLAIM_TOKEN,
      "unsupported outbox event_type=memory.deleted",
      expect.any(String),
    );
  });
});
