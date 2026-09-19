import { HttpException, HttpStatus } from "@nestjs/common";

import { findSecrets } from "./find-secrets";

// Spec 04 / Spec 02 §9: OpenKT never stores credentials, even when asked to.
// Every save path — facts (REST and kt_save_memory), session turns, titles
// and summaries, /v1/capture prompts, skill files — calls refuseSecrets()
// before anything is written. A match is a 422 `contains_secret` whose
// message names the KIND of secret; the matched text is never echoed.

const KIND_LABELS: Record<string, string> = {
  aws_access_key: "an AWS access key",
  github_token: "a GitHub token",
  openai_key: "an OpenAI API key",
  anthropic_key: "an Anthropic API key",
  slack_token: "a Slack token",
  openkt_pat: "an OpenKT access token",
  private_key: "a private key",
  jwt: "a signed token (JWT)",
  connection_string: "a connection string with a password",
  password_assignment: "a password or API key value",
  card_number: "a payment card number",
};

const joinLabels = (labels: string[]): string =>
  labels.length <= 1 ? (labels[0] ?? "a secret") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

export class ContainsSecretError extends HttpException {
  constructor(
    public readonly kinds: string[],
    what: string,
  ) {
    const labels = [...new Set(kinds.map((kind) => KIND_LABELS[kind] ?? "a secret"))];
    super(
      {
        code: "contains_secret",
        message:
          `This ${what} looks like it contains ${joinLabels(labels)}. ` +
          "OpenKT never stores credentials — remove it and save again.",
        kinds,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// Throws ContainsSecretError when any of the texts holds a secret. `what`
// names the thing being saved ("fact", "turn", "skill", …) for the message.
export function refuseSecrets(what: string, ...texts: Array<string | null | undefined>): void {
  const kinds = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of findSecrets(text)) kinds.add(match.type);
  }
  if (kinds.size > 0) throw new ContainsSecretError([...kinds], what);
}
