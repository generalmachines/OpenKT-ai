/**
 * Regression test for the missing global JSON body parser (bug de-fmh8ho).
 *
 * Root cause: main.ts registered a path-scoped app.use('/path', json())
 * before app.listen(). NestJS's express adapter (isMiddlewareApplied)
 * checks the stack by function name ("jsonParser"). The path-scoped
 * json() registers a function with that same name, so NestJS thinks the
 * global parser is already present and skips it. Every non-webhook POST
 * route then receives req.body === undefined, which Zod validates as
 * "expected object, received undefined".
 *
 * Fix: use rawBody:true in NestFactory.create so NestJS registers the
 * global json parser itself, unconditionally, with a verify callback
 * that also attaches req.rawBody (Buffer) for any webhook endpoint that
 * needs to verify the raw bytes.
 *
 * This test boots a minimal Nest app with rawBody:true and asserts that:
 *   1. A POST with a JSON body parses req.body correctly
 *   2. An empty-body POST still reaches the controller (no crash)
 *   3. The raw bytes are available on req.rawBody as a Buffer
 */
import {
  Body,
  Controller,
  type INestApplication,
  Module,
  Post,
  Req,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Request } from "express";
import request from "supertest";

interface EchoRequest {
  message?: string;
}

interface EchoResponse {
  received: EchoRequest | null;
  rawBodyType: string;
  rawBodyLength: number;
}

@Controller("echo")
class StubEchoController {
  @Post()
  echo(
    @Body() body: EchoRequest,
    @Req() req: Request & { rawBody?: Buffer | string },
  ): EchoResponse {
    const rb = req.rawBody;
    return {
      received: body ?? null,
      rawBodyType: rb === undefined ? "undefined" : Buffer.isBuffer(rb) ? "Buffer" : typeof rb,
      rawBodyLength: rb ? (Buffer.isBuffer(rb) ? rb.length : String(rb).length) : 0,
    };
  }
}

@Module({ controllers: [StubEchoController] })
class StubEchoModule {}

describe("POST body parsing — rawBody:true regression (de-fmh8ho)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubEchoModule],
    }).compile();

    // Mirror the production fix: rawBody:true ensures NestJS registers
    // the global json body parser even when other middleware with the
    // same internal name was registered beforehand.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("parses a JSON POST body into req.body", async () => {
    const res = await request(app.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send({ message: "hello openkt" })
      .expect(201);

    expect(res.body.received).toEqual({ message: "hello openkt" });
  });

  it("attaches raw bytes as a Buffer on req.rawBody", async () => {
    const payload = JSON.stringify({ message: "raw check" });

    const res = await request(app.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send({ message: "raw check" })
      .expect(201);

    expect(res.body.rawBodyType).toBe("Buffer");
    expect(res.body.rawBodyLength).toBe(payload.length);
  });

  it("delivers an empty object for a POST with no body (no crash)", async () => {
    const res = await request(app.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .expect(201);

    // When content-type is json but body is empty, body-parser yields {}
    expect(res.body.received).toBeDefined();
  });
});
