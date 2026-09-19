const BOUNDARY_TAG_RE = /<\s*\/?\s*untrusted-content\s*>/gi;

export function stripPromptBoundary(input: string): string {
  return input.replace(BOUNDARY_TAG_RE, "[boundary-tag]");
}
