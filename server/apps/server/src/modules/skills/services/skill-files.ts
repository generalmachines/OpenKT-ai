import { HttpException, HttpStatus } from "@nestjs/common";

// The open Agent Skills format, as far as this server cares: a folder of text
// files with a required `SKILL.md` at its root. SKILL.md opens with YAML
// frontmatter carrying `name` (lowercase kebab, ≤ 64) and `description`
// (≤ 1024), followed by a markdown body. Pure functions, no I/O — the limits
// and the parser are unit-tested in test/unit/skill-files.spec.ts.

export interface SkillFile {
  path: string;
  content: string;
}

export const SKILL_MD = "SKILL.md";
export const SKILL_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 200 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxPathLength: 200,
  maxNameLength: 64,
  maxDescriptionLength: 1024,
  maxTitleLength: 200,
} as const;

export type SkillFileErrorCode =
  | "invalid_frontmatter"
  | "missing_skill_md"
  | "file_too_large"
  | "skill_too_large"
  | "too_many_files"
  | "bad_path"
  | "not_text";

// 422 with a stable code; AppExceptionFilter unwraps `{code, message}`.
export class SkillFileError extends HttpException {
  constructor(
    public readonly code: SkillFileErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super({ code, message, ...details }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export interface ParsedSkill {
  name: string;
  description: string;
  // First `# heading` of the body, if there is one.
  heading: string | null;
  body: string;
}

export interface ValidatedSkill extends ParsedSkill {
  files: SkillFile[];
  totalBytes: number;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
// Control characters other than tab, LF, CR — a text file has none.
// eslint-disable-next-line no-control-regex
const BINARY_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
// eslint-disable-next-line no-control-regex
const PATH_CONTROL_RE = /[\x00-\x1F\x7F]/;
const BOM = String.fromCharCode(0xfeff);

export const bytesOf = (content: string): number => Buffer.byteLength(content, "utf8");

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.maxNameLength)
    .replace(/-+$/g, "");
  return slug || "skill";
}

// Reads the top-level scalar keys of a YAML frontmatter block: plain, quoted,
// and block (`|`, `>`) scalars, plus indented continuation lines. Nested maps
// and lists (e.g. `metadata:`) are skipped — only `name` and `description`
// matter here, and a full YAML parser is not worth a dependency.
export function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = KEY_RE.exec(line);
    if (!match) {
      if (/^\s/.test(line)) continue; // part of a nested value we do not read
      throw new SkillFileError("invalid_frontmatter", `frontmatter line is not \`key: value\`: "${line.slice(0, 80)}"`);
    }
    const key = match[1]!;
    const rest = (match[2] ?? "").trim();
    const indented: string[] = [];
    while (i < lines.length && (/^\s+\S/.test(lines[i]!) || !lines[i]!.trim())) {
      indented.push(lines[i]!.trim());
      i++;
    }
    if (/^[|>][+-]?$/.test(rest)) {
      out[key] = rest.startsWith("|")
        ? indented.join("\n").trim()
        : indented.join(" ").replace(/\s+/g, " ").trim();
    } else {
      const continuation = rest ? indented.filter((l) => l && !l.startsWith("- ") && !KEY_RE.test(l)) : [];
      out[key] = unquote([rest, ...continuation].join(" ").trim());
    }
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  // A trailing ` # comment` on a plain scalar.
  return value.replace(/\s+#.*$/, "");
}

export function parseSkillMd(source: string): ParsedSkill {
  const text = (source.startsWith(BOM) ? source.slice(1) : source).replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) {
    throw new SkillFileError(
      "invalid_frontmatter",
      "SKILL.md must start with YAML frontmatter between two `---` lines, holding `name` and `description`",
    );
  }
  const fields = parseFrontmatter(match[1]!);
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (!name) throw new SkillFileError("invalid_frontmatter", "frontmatter `name` is required");
  if (name.length > SKILL_LIMITS.maxNameLength || !NAME_RE.test(name)) {
    throw new SkillFileError(
      "invalid_frontmatter",
      `frontmatter \`name\` must be lowercase letters, digits and single hyphens, at most ${SKILL_LIMITS.maxNameLength} characters (got "${name.slice(0, 80)}")`,
    );
  }
  if (!description) throw new SkillFileError("invalid_frontmatter", "frontmatter `description` is required");
  if (description.length > SKILL_LIMITS.maxDescriptionLength) {
    throw new SkillFileError(
      "invalid_frontmatter",
      `frontmatter \`description\` is ${description.length} characters; the limit is ${SKILL_LIMITS.maxDescriptionLength}`,
    );
  }
  const body = text.slice(match[0].length);
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)?.[1]?.trim() ?? null;
  return { name, description, heading: heading ? heading.slice(0, SKILL_LIMITS.maxTitleLength) : null, body };
}

function checkPath(path: unknown): asserts path is string {
  const bad = (why: string): never => {
    throw new SkillFileError("bad_path", `file path ${JSON.stringify(path)} ${why}`, { path });
  };
  if (typeof path !== "string" || !path) return bad("must be a non-empty string");
  if (path.length > SKILL_LIMITS.maxPathLength) return bad(`is longer than ${SKILL_LIMITS.maxPathLength} characters`);
  if (path.startsWith("/")) return bad("must be relative (no leading `/`)");
  if (path.includes("\\")) return bad("must use `/` as the separator");
  if (/^[A-Za-z]:/.test(path)) return bad("must be relative (no drive letter)");
  if (PATH_CONTROL_RE.test(path)) return bad("contains control characters");
  for (const segment of path.split("/")) {
    if (segment === "") return bad("has an empty segment");
    if (segment === ".." || segment === ".") return bad("must not contain `.` or `..` segments");
  }
}

// Checks the whole folder and returns it normalised (SKILL.md first, the rest
// by path) together with what SKILL.md says. Throws SkillFileError (422).
export function validateSkillFiles(input: readonly SkillFile[]): ValidatedSkill {
  if (input.length > SKILL_LIMITS.maxFiles) {
    throw new SkillFileError("too_many_files", `a skill holds at most ${SKILL_LIMITS.maxFiles} files (got ${input.length})`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of input) {
    checkPath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new SkillFileError("bad_path", `file path "${file.path}" appears twice`, { path: file.path });
    seen.add(key);
    if (typeof file.content !== "string") {
      throw new SkillFileError("not_text", `"${file.path}" has no text content`, { path: file.path });
    }
    if (BINARY_RE.test(file.content)) {
      throw new SkillFileError("not_text", `"${file.path}" is not a UTF-8 text file`, { path: file.path });
    }
    const bytes = bytesOf(file.content);
    if (bytes > SKILL_LIMITS.maxFileBytes) {
      throw new SkillFileError(
        "file_too_large",
        `"${file.path}" is ${bytes} bytes; a file may be at most ${SKILL_LIMITS.maxFileBytes}`,
        { path: file.path, bytes },
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > SKILL_LIMITS.maxTotalBytes) {
    throw new SkillFileError(
      "skill_too_large",
      `the skill is ${totalBytes} bytes in total; the limit is ${SKILL_LIMITS.maxTotalBytes}`,
      { bytes: totalBytes },
    );
  }
  const skillMd = input.find((f) => f.path === SKILL_MD);
  if (!skillMd) throw new SkillFileError("missing_skill_md", "a skill needs a `SKILL.md` file at its root");

  const parsed = parseSkillMd(skillMd.content);
  const files = [...input]
    .map((f) => ({ path: f.path, content: f.content }))
    .sort((a, b) => (a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path.localeCompare(b.path)));
  return { ...parsed, files, totalBytes };
}

// What "New skill" gives you when all you typed was a title.
export function starterSkillMd(title: string, name = slugify(title)): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const description = `Describe what "${clean}" does and when to use it, so a tool can tell when this skill applies.`;
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${clean}`,
    "",
    "One or two sentences on what this skill is for.",
    "",
    "## When to use it",
    "",
    "- The situations or requests that should trigger this skill.",
    "",
    "## Steps",
    "",
    "1. The first thing to do.",
    "2. The next thing.",
    "3. What to show when it is done.",
    "",
  ].join("\n");
}

// The one text a tool reads: SKILL.md, then every other file under a header.
export function renderSkillText(files: readonly SkillFile[]): string {
  const skillMd = files.find((f) => f.path === SKILL_MD);
  const rest = files.filter((f) => f.path !== SKILL_MD);
  return [
    (skillMd?.content ?? "").trimEnd(),
    ...rest.map((f) => `--- ${f.path} ---\n${f.content.trimEnd()}`),
  ].join("\n\n");
}
