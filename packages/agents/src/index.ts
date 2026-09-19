// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { brief } from "./agents/brief.js";
import { dedupe } from "./agents/dedupe.js";
import { describeImage } from "./agents/describe-image.js";
import { extract } from "./agents/extract.js";
import { route } from "./agents/route.js";
import { summarise } from "./agents/summarise.js";
import { tag } from "./agents/tag.js";
import { writeSection } from "./agents/write-section.js";

export * from "./types.js";
export * from "./errors.js";
export * from "./secrets.js";
export * from "./define-agent.js";
export * from "./openai-client.js";
export { AGENT_NAMES, PROMPTS, SCHEMAS, type AgentName } from "./generated/contract.js";
export { CITATION, citedIds, fence, fenceJson, normaliseForMatch, parseModelJson, stripThink } from "./text.js";

export * from "./agents/extract.js";
export * from "./agents/tag.js";
export * from "./agents/dedupe.js";
export * from "./agents/route.js";
export * from "./agents/write-section.js";
export * from "./agents/summarise.js";
export * from "./agents/describe-image.js";
export * from "./agents/brief.js";

/** Every agent by its contract name. */
export const agents = {
  extract,
  tag,
  dedupe,
  route,
  write_section: writeSection,
  summarise,
  describe_image: describeImage,
  brief,
} as const;
