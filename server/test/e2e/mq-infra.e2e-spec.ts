/**
 * E2E test for Track C.1 — MqModule topology assertion.
 *
 * What this proves:
 *   - MqModule composes via the public Nest DI graph (ConfigModule
 *     hydrated with a synthetic RABBITMQ_URL → AmqpConnectionManager
 *     factory → RmqInfraService).
 *   - On module init, the setup channel callback registered by
 *     amqp-connection-manager is invoked with a real `Channel`-shaped
 *     object, and the three exchanges declared in `mq.constants.ts`
 *     are asserted with the spec-mandated types and `durable: true`.
 *   - RmqPublisher's confirm-channel wrapper is created at boot.
 *
 * What this is NOT:
 *   - Not a live-broker test. amqp-connection-manager is mocked so
 *     the assertion happens against a JS object instead of a TCP
 *     connection. A future integration test (Track C.2 onward) can
 *     spin up testcontainers/rabbitmq if we want broker-side coverage.
 *
 * If you change exchange names, types, or the durability flag in
 * `mq.constants.ts` / `RmqInfraService`, this test should fail loudly.
 * That's the contract this guards.
 */
const setupCalls: Array<{
  name: string | undefined;
  setup: ((channel: unknown) => unknown) | undefined;
  confirm: boolean | undefined;
  json: boolean | undefined;
}> = [];

const channelMock = {
  assertExchange: jest.fn().mockResolvedValue(undefined),
  assertQueue: jest.fn().mockResolvedValue(undefined),
  bindQueue: jest.fn().mockResolvedValue(undefined),
};

jest.mock("amqp-connection-manager", () => {
  const fakeConnection = {
    createChannel: jest
      .fn()
      .mockImplementation(
        (opts: {
          name?: string;
          setup?: (channel: unknown) => unknown;
          confirm?: boolean;
          json?: boolean;
        }) => {
          setupCalls.push({
            name: opts?.name,
            setup: opts?.setup,
            confirm: opts?.confirm,
            json: opts?.json,
          });
          return {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
          };
        },
      ),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };

  return {
    __esModule: true,
    connect: jest.fn().mockReturnValue(fakeConnection),
    // re-export named types as no-ops so TS imports resolve
    AmqpConnectionManager: class {},
    ChannelWrapper: class {},
  };
});

import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";

import {
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_DLX_EXCHANGE,
  MEMORY_EVENTS_EXCHANGE,
} from "../../apps/worker/src/modules/mq/mq.constants";
import { MqModule } from "../../apps/worker/src/modules/mq/mq.module";
import { RmqInfraService } from "../../apps/worker/src/modules/mq/rmq-infra.service";
import { RmqPublisher } from "../../apps/worker/src/modules/mq/rmq-publisher.service";

describe("MqModule (Track C.1 e2e)", () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    setupCalls.length = 0;
    channelMock.assertExchange.mockClear();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              RABBITMQ_URL: "amqp://test:test@localhost:5672/",
            }),
          ],
        }),
        MqModule,
      ],
    }).compile();

    await moduleRef.init();

    // Run the setup callback that amqp-connection-manager would call on
    // a successful connect. The mock recorded it; we drive it manually
    // because we are not connecting to a real broker.
    const infraSetup = setupCalls.find((c) => c.name === "rmq-infra-topology");
    if (!infraSetup?.setup) {
      throw new Error("RmqInfraService did not register a setup channel");
    }
    await infraSetup.setup(channelMock);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("registers RmqInfraService and RmqPublisher in the DI graph", () => {
    expect(moduleRef.get(RmqInfraService)).toBeInstanceOf(RmqInfraService);
    expect(moduleRef.get(RmqPublisher)).toBeInstanceOf(RmqPublisher);
  });

  it("opens a confirm-channel publisher (json + confirm flags set)", () => {
    const publisherSetup = setupCalls.find((c) => c.name === "rmq-publisher");
    expect(publisherSetup).toBeDefined();
    expect(publisherSetup?.confirm).toBe(true);
    expect(publisherSetup?.json).toBe(true);
  });

  it("asserts the three durable exchanges from the spec", () => {
    expect(channelMock.assertExchange).toHaveBeenCalledTimes(3);

    expect(channelMock.assertExchange).toHaveBeenCalledWith(
      MEMORY_COMMANDS_EXCHANGE,
      "topic",
      { durable: true },
    );
    expect(channelMock.assertExchange).toHaveBeenCalledWith(
      MEMORY_EVENTS_EXCHANGE,
      "topic",
      { durable: true },
    );
    expect(channelMock.assertExchange).toHaveBeenCalledWith(
      MEMORY_DLX_EXCHANGE,
      "topic",
      { durable: true },
    );
  });
});
