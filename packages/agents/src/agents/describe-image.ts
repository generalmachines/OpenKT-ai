// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { AgentInputError } from "../errors.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { fence, words } from "../text.js";
import type { ContentPart } from "../types.js";

export interface DescribeImageInput {
  /** An http(s) or data: URL, or raw base64 with its MIME type. */
  image: { url: string } | { base64: string; mime_type: string };
  /** What the user typed or said about the image, if anything. */
  caption?: string;
  /** OCR of the image when the caller has one (Apple Vision on the desktop). The model copies from it instead of re-reading pixels. */
  ocr_text?: string;
}
export interface DescribeImageOutput {
  description: string;
  visible_text: string;
  entities: string[];
}

/** Spec 03 §4. */
export const MAX_DESCRIPTION_WORDS = 60;
const MAX_OCR_CHARS = 6000;

export function imageUrl(image: DescribeImageInput["image"]): string {
  return "url" in image ? image.url : `data:${image.mime_type};base64,${image.base64}`;
}

export const describeImage = defineAgent<DescribeImageInput, DescribeImageOutput>({
  name: "describe_image",
  prompt: PROMPTS.describe_image,
  schema: SCHEMAS.describe_image,
  maxTokens: 1500,
  checkInput(input) {
    const url = imageUrl(input.image);
    if (!/^(https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)\S+$/i.test(url)) {
      throw new AgentInputError("describe_image needs an http(s) URL, a data:image/…;base64 URL, or base64 with an image mime_type");
    }
  },
  render(input): ContentPart[] {
    const caption = input.caption?.trim();
    const ocr = input.ocr_text?.trim();
    const text = [caption ? fence("caption", caption) : "No caption was given.", ...(ocr ? [fence("ocr_text", ocr.slice(0, MAX_OCR_CHARS))] : [])];
    return [
      { type: "image_url", image_url: { url: imageUrl(input.image) } },
      { type: "text", text: text.join("\n\n") },
    ];
  },
  postValidate(output) {
    const all = words(output.description);
    const description = all.length > MAX_DESCRIPTION_WORDS ? `${all.slice(0, MAX_DESCRIPTION_WORDS).join(" ")}…` : output.description.trim();
    const entities = [...new Map(output.entities.map((e) => [e.trim().toLowerCase(), e.trim()])).values()].filter(Boolean);
    return {
      ok: true,
      output: { description, visible_text: output.visible_text.trim(), entities },
      dropped: output.entities.length - entities.length,
      notes: all.length > MAX_DESCRIPTION_WORDS ? [`description cut to ${MAX_DESCRIPTION_WORDS} words`] : [],
    };
  },
  noop: () => ({ description: "", visible_text: "", entities: [] }),
});
