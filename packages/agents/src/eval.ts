// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
// Fixture loading and the evaluation loop. Node-only; kept out of the main entry point.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Agent } from "./define-agent.js";
import { AGENT_NAMES, type AgentName } from "./generated/contract.js";
import { agents } from "./index.js";
import { LlmTransportError } from "./errors.js";
import type { AgentResult, LlmClient } from "./types.js";

/** Checks that hold for any correct output, from a scripted reply or a live model. */
export interface Expectation {
  /** Case-insensitive substrings of the serialised output: all / at least one / none. */
  require_all?: string[];
  require_any?: string[];
  forbid?: string[];
  /** Length bounds of the array at this top-level key, e.g. {key: "facts", min: 2, max: 10}. */
  count?: { key: string; min?: number; max?: number };
  /** Deep partial match against the output. */
  equals?: unknown;
}

export interface Fixture {
  agent: AgentName;
  name: string;
  description: string;
  input: unknown;
  expect: Expectation;
  /** Scripted replies for unit tests, one per attempt. Objects are serialised; strings are sent raw. */
  mock_replies: unknown[];
  /** What the run over mock_replies must report. */
  mock_expect: { status: "ok" | "noop"; attempts?: number; dropped?: number; output?: unknown };
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** Reads fixtures/<agent>/*.json. `image_file` (relative to the fixture) becomes input.image. */
export function loadFixtures(dir: string): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const agent of AGENT_NAMES) {
    const folder = join(dir, agent);
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".json")).sort()) {
      const raw = JSON.parse(readFileSync(join(folder, file), "utf8")) as Fixture & { image_file?: string };
      if (raw.image_file) {
        const mime_type = MIME[extname(raw.image_file).toLowerCase()] ?? "application/octet-stream";
        const base64 = readFileSync(join(folder, raw.image_file)).toString("base64");
        raw.input = { ...(raw.input as object), image: { base64, mime_type } };
      }
      fixtures.push({ ...raw, agent, name: raw.name ?? file.replace(/\.json$/, "") });
    }
  }
  return fixtures;
}

/** Returns the failed checks; empty means the expectation holds. */
export function checkExpectation(output: unknown, expect: Expectation): string[] {
  const failures: string[] = [];
  const text = JSON.stringify(output).toLowerCase();
  const has = (s: string) => text.includes(JSON.stringify(s).slice(1, -1).toLowerCase());
  for (const s of expect.require_all ?? []) if (!has(s)) failures.push(`missing "${s}"`);
  if (expect.require_any?.length && !expect.require_any.some(has)) failures.push(`none of ${JSON.stringify(expect.require_any)}`);
  for (const s of expect.forbid ?? []) if (has(s)) failures.push(`contains forbidden "${s}"`);
  if (expect.count) {
    const value = (output as Record<string, unknown>)?.[expect.count.key];
    const n = Array.isArray(value) ? value.length : -1;
    if (n < (expect.count.min ?? 0) || n > (expect.count.max ?? Infinity)) {
      failures.push(`${expect.count.key} has ${n} items, expected ${expect.count.min ?? 0}–${expect.count.max ?? "∞"}`);
    }
  }
  if (expect.equals !== undefined && !partialMatch(output, expect.equals)) failures.push(`output does not match ${JSON.stringify(expect.equals)}`);
  return failures;
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => partialMatch(actual[i], e));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => partialMatch((actual as Record<string, unknown>)[k], v));
}

export interface EvalRun {
  fixture: Fixture;
  result: AgentResult<unknown>;
  failures: string[];
  /** Set when the endpoint failed for this fixture (HTTP error, timeout); the run counts as neither valid nor a no-op. */
  transport_error?: string;
}

export interface EvalRow {
  agent: AgentName;
  runs: number;
  /** Share of runs that ended in validated JSON (status "ok"), and share that did so first try. */
  valid_json_rate: number;
  first_try_rate: number;
  /** Share of runs whose output met the fixture's expectation. */
  expectation_rate: number;
  /** extract only: facts dropped by the quote gate / facts returned by the model. */
  quote_gate_drop_rate: number | null;
  noops: number;
  transport_errors: number;
  latency_ms_mean: number;
  latency_ms_p50: number;
  latency_ms_max: number;
  completion_tokens: number;
}

export async function runFixture(fixture: Fixture, client: LlmClient): Promise<EvalRun> {
  const agent = agents[fixture.agent] as unknown as Agent<unknown, unknown>;
  let result: AgentResult<unknown>;
  try {
    result = await agent.run(fixture.input, client);
  } catch (e) {
    // One fixture the endpoint cannot serve (say, an image on a text-only model) must not end the evaluation.
    if (!(e instanceof LlmTransportError)) throw e;
    const transport_error = `${e.message}${e.body ? ` — ${e.body.slice(0, 200)}` : ""}`;
    result = { output: null, status: "noop", attempts: 0, dropped: 0, notes: [], errors: [transport_error], latency_ms: 0 };
    return { fixture, result, failures: [`transport: ${transport_error}`], transport_error };
  }
  const failures = result.status === "ok" ? checkExpectation(result.output, fixture.expect) : ["no-op"];
  return { fixture, result, failures };
}

/** Runs every fixture sequentially (a local model serves one request at a time) and aggregates per agent. */
export async function runEval(fixtures: Fixture[], client: LlmClient, onRun?: (run: EvalRun) => void): Promise<{ rows: EvalRow[]; runs: EvalRun[] }> {
  const runs: EvalRun[] = [];
  for (const fixture of fixtures) {
    const run = await runFixture(fixture, client);
    runs.push(run);
    onRun?.(run);
  }
  const rows = AGENT_NAMES.filter((agent) => runs.some((r) => r.fixture.agent === agent)).map((agent) => summariseRuns(agent, runs.filter((r) => r.fixture.agent === agent)));
  return { rows, runs };
}

function summariseRuns(agent: AgentName, runs: EvalRun[]): EvalRow {
  const n = runs.length;
  const latencies = runs.map((r) => r.result.latency_ms).sort((a, b) => a - b);
  const share = (pred: (r: EvalRun) => boolean) => runs.filter(pred).length / n;
  let quote_gate_drop_rate: number | null = null;
  if (agent === "extract") {
    // Denominator: every fact the model returned. Numerator: the quote gate's own count, which it reports
    // in a note — result.dropped also includes credentials and repeats.
    const returned = runs.reduce((sum, r) => sum + ((r.result.output as { facts?: unknown[] } | null)?.facts?.length ?? 0) + r.result.dropped, 0);
    const gated = runs.reduce((sum, r) => sum + Number(r.result.notes.join("\n").match(/quote gate dropped (\d+)/)?.[1] ?? 0), 0);
    quote_gate_drop_rate = returned ? gated / returned : 0;
  }
  return {
    agent,
    runs: n,
    valid_json_rate: share((r) => r.result.status === "ok"),
    first_try_rate: share((r) => r.result.status === "ok" && r.result.attempts <= 1),
    expectation_rate: share((r) => r.failures.length === 0),
    quote_gate_drop_rate,
    noops: runs.filter((r) => r.result.status === "noop" && !r.transport_error).length,
    transport_errors: runs.filter((r) => r.transport_error).length,
    latency_ms_mean: Math.round(latencies.reduce((a, b) => a + b, 0) / n),
    latency_ms_p50: latencies[Math.floor((n - 1) / 2)] ?? 0,
    latency_ms_max: latencies.at(-1) ?? 0,
    completion_tokens: runs.reduce((sum, r) => sum + (r.result.usage?.completion_tokens ?? 0), 0),
  };
}

export function formatTable(rows: EvalRow[]): string {
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
  const header = ["agent", "runs", "valid JSON", "first try", "expect ok", "quote drops", "no-ops", "errors", "mean ms", "p50 ms", "max ms", "out tok"];
  const body = rows.map((r) => [
    r.agent, String(r.runs), pct(r.valid_json_rate), pct(r.first_try_rate), pct(r.expectation_rate), pct(r.quote_gate_drop_rate),
    String(r.noops), String(r.transport_errors), String(r.latency_ms_mean), String(r.latency_ms_p50), String(r.latency_ms_max), String(r.completion_tokens),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), widths.map((w) => "─".repeat(w)).join("  "), ...body.map(line)].join("\n");
}
