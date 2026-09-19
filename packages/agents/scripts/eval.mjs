#!/usr/bin/env node
// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
// Live evaluation: runs every fixture against a real OpenAI-compatible endpoint.
//
//   OPENKT_LLM_BASE_URL=http://localhost:8080/v1 npm run eval
//   OPENKT_LLM_BASE_URL=… npm run eval -- --agent extract --verbose
//
// Optional: OPENKT_LLM_API_KEY, OPENKT_LLM_MODEL (default qwen3.5-4b),
// OPENKT_LLM_RESPONSE_FORMAT=json_schema|json_object|none, OPENKT_LLM_THINKING_KWARG=0,
// OPENKT_LLM_NO_THINK_PREFIX=1.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { clientFromEnv } from "../dist/index.js";
import { formatTable, loadFixtures, runEval } from "../dist/eval.js";

const { values } = parseArgs({
  options: {
    agent: { type: "string", multiple: true },
    fixture: { type: "string", multiple: true },
    verbose: { type: "boolean", short: "v", default: false },
    json: { type: "boolean", default: false },
  },
});

if (!process.env.OPENKT_LLM_BASE_URL) {
  console.log("OPENKT_LLM_BASE_URL is not set — nothing to evaluate.\nExample: OPENKT_LLM_BASE_URL=http://localhost:8080/v1 npm run eval");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = loadFixtures(join(root, "fixtures")).filter(
  (f) => (!values.agent || values.agent.includes(f.agent)) && (!values.fixture || values.fixture.includes(f.name)),
);
if (!fixtures.length) {
  console.error("No fixture matches the given --agent / --fixture filters.");
  process.exit(2);
}

const client = clientFromEnv();
const model = process.env.OPENKT_LLM_MODEL || "qwen3.5-4b";
if (!values.json) console.log(`Evaluating ${fixtures.length} fixtures against ${process.env.OPENKT_LLM_BASE_URL} (model ${model})\n`);

const { rows, runs } = await runEval(fixtures, client, (run) => {
  if (values.json) return;
  const { fixture, result, failures } = run;
  const mark = run.transport_error ? "ERR " : result.status === "noop" ? "NOOP" : failures.length ? "FAIL" : "ok  ";
  console.log(`${mark} ${fixture.agent}/${fixture.name}  attempts=${result.attempts} dropped=${result.dropped} ${result.latency_ms}ms`);
  for (const line of [...result.errors, ...failures.filter((f) => f !== "no-op" && !f.startsWith("transport:"))]) console.log(`       ${line}`);
  if (values.verbose) {
    for (const note of result.notes) console.log(`       note: ${note}`);
    console.log(`       ${JSON.stringify(result.output)}`);
  }
});

if (values.json) {
  console.log(JSON.stringify({ model, base_url: process.env.OPENKT_LLM_BASE_URL, rows, runs: runs.map(({ fixture, ...rest }) => ({ agent: fixture.agent, fixture: fixture.name, ...rest })) }, null, 2));
} else {
  console.log(`\n${formatTable(rows)}`);
}
process.exit(rows.some((r) => r.transport_errors) ? 1 : 0);
