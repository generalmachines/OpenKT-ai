// Confidence (Spec 02 §8): computed from how a fact was obtained, never
// asked from a model.

import type { TurnRole } from "./types.js";

export const MARKED_WRONG = 0.1;

const EXPLICIT_SAVE = 0.9;
const EXTRACTED_USER = 0.75;
const EXTRACTED_ASSISTANT = 0.55;
const EXTRACTED_ASSISTANT_CONTRADICTED = 0.3;
const LOW_SIGNAL = 0.5;

const CONFIRM_BUMP = 0.1;
const CONFIRM_CAP = 0.95;

export interface ConfidenceInput {
  origin: "explicit_save" | "extracted";
  source: string;
  quoteTurnRole?: TurnRole;
  contradictedLater?: boolean;
  speakerKnown?: boolean;
  quoteFrom?: "transcript" | "image_description" | "ocr";
}

export function assignConfidence(input: ConfidenceInput): number {
  if (input.origin === "explicit_save") return EXPLICIT_SAVE;

  if (input.quoteFrom === "image_description" || input.quoteFrom === "ocr") return LOW_SIGNAL;

  if (input.quoteTurnRole === "user") return EXTRACTED_USER;

  if (input.quoteTurnRole === "assistant") {
    return input.contradictedLater ? EXTRACTED_ASSISTANT_CONTRADICTED : EXTRACTED_ASSISTANT;
  }

  // Meeting speech with an unknown speaker — and anything not covered.
  return LOW_SIGNAL;
}

export function bumpOnConfirmation(current: number): number {
  return Math.min(current + CONFIRM_BUMP, CONFIRM_CAP);
}
