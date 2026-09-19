/**
 * The Agent Skills folder rules, as pure functions: SKILL.md frontmatter,
 * path / size / count limits, the starter SKILL.md, and the text a tool reads.
 */
import {
  SKILL_LIMITS,
  SkillFileError,
  parseSkillMd,
  renderSkillText,
  slugify,
  starterSkillMd,
  validateSkillFiles,
  type SkillFile,
} from "../../apps/server/src/modules/skills/services/skill-files";
import { STARTER_SKILL_MD } from "../../apps/server/src/modules/skills/services/starter-skill";
import { SERVER_INSTRUCTIONS } from "../../apps/server/src/modules/mcp/services/mcp-server-factory.service";

const md = (frontmatter: string, body = "\n# Title\n\nBody.\n") => `---\n${frontmatter}\n---\n${body}`;
const GOOD = md("name: sharpen-message\ndescription: Rewrite a draft in our voice.");

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof SkillFileError) {
      expect(err.getStatus()).toBe(422);
      return err.code;
    }
    throw err;
  }
}

describe("SKILL.md frontmatter", () => {
  it.each([
    ["plain scalars", "name: sharpen-message\ndescription: Rewrite a draft in our voice.", "sharpen-message", "Rewrite a draft in our voice."],
    ["double quotes", 'name: "a1"\ndescription: "Says \\"hi\\": always."', "a1", 'Says "hi": always.'],
    ["single quotes", "name: 'x-2'\ndescription: 'It''s fine.'", "x-2", "It's fine."],
    ["folded block", "name: fold\ndescription: >\n  First line\n  second line.\n", "fold", "First line second line."],
    ["literal block", "name: lit\ndescription: |\n  Line one\n  line two", "lit", "Line one\nline two"],
    ["continuation lines", "name: cont\ndescription: Starts here\n  and goes on.", "cont", "Starts here and goes on."],
    ["extra keys, nested maps, comments", "# comment\nname: extra\nlicense: MIT\nmetadata:\n  author: ana\n  tags:\n    - a\ndescription: Works. # trailing", "extra", "Works."],
    ["a colon inside the description", "name: colon\ndescription: Use when: the user asks.", "colon", "Use when: the user asks."],
    ["64-character name", `name: ${"a".repeat(64)}\ndescription: ok`, "a".repeat(64), "ok"],
  ])("accepts %s", (_label, frontmatter, name, description) => {
    const parsed = parseSkillMd(md(frontmatter));
    expect(parsed.name).toBe(name);
    expect(parsed.description).toBe(description);
    expect(parsed.heading).toBe("Title");
  });

  it("reads CRLF files and a leading byte-order mark", () => {
    const parsed = parseSkillMd(String.fromCharCode(0xfeff) + GOOD.replace(/\n/g, "\r\n"));
    expect(parsed).toMatchObject({ name: "sharpen-message", heading: "Title" });
  });

  it.each([
    ["no frontmatter at all", "# Just markdown\n"],
    ["frontmatter never closed", "---\nname: a\ndescription: b\n\n# Title\n"],
    ["frontmatter not at the top", `\n\nintro\n${GOOD}`],
    ["missing name", md("description: something")],
    ["missing description", md("name: something")],
    ["empty description", md('name: something\ndescription: ""')],
    ["uppercase name", md("name: Sharpen\ndescription: d")],
    ["name with spaces", md("name: sharpen message\ndescription: d")],
    ["name with underscore", md("name: sharpen_message\ndescription: d")],
    ["leading hyphen", md("name: -sharpen\ndescription: d")],
    ["double hyphen", md("name: sharpen--message\ndescription: d")],
    ["65-character name", md(`name: ${"a".repeat(65)}\ndescription: d`)],
    ["1025-character description", md(`name: long\ndescription: ${"d".repeat(1025)}`)],
    ["a line that is not key: value", md("name: a\nthis is not yaml\ndescription: d")],
  ])("rejects %s → invalid_frontmatter", (_label, source) => {
    expect(codeOf(() => parseSkillMd(source))).toBe("invalid_frontmatter");
  });

  it("accepts a description of exactly 1024 characters", () => {
    expect(parseSkillMd(md(`name: long\ndescription: ${"d".repeat(1024)}`)).description).toHaveLength(1024);
  });
});

describe("skill folder limits", () => {
  const skill = (extra: SkillFile[] = []) => [{ path: "SKILL.md", content: GOOD }, ...extra];

  it("normalises a good folder: SKILL.md first, the rest by path", () => {
    const result = validateSkillFiles([
      { path: "references/voice.md", content: "voice" },
      { path: "SKILL.md", content: GOOD },
      { path: "examples/a.md", content: "a" },
    ]);
    expect(result.files.map((f) => f.path)).toEqual(["SKILL.md", "examples/a.md", "references/voice.md"]);
    expect(result).toMatchObject({ name: "sharpen-message", description: "Rewrite a draft in our voice." });
  });

  it("needs a SKILL.md at the root → missing_skill_md", () => {
    expect(codeOf(() => validateSkillFiles([]))).toBe("missing_skill_md");
    expect(codeOf(() => validateSkillFiles([{ path: "docs/SKILL.md", content: GOOD }]))).toBe("missing_skill_md");
    expect(codeOf(() => validateSkillFiles([{ path: "skill.md", content: GOOD }]))).toBe("missing_skill_md");
  });

  it.each([
    ["/etc/passwd"],
    ["../outside.md"],
    ["references/../../outside.md"],
    ["./SKILL2.md"],
    ["references//voice.md"],
    ["references/"],
    ["references\\voice.md"],
    ["C:/windows.md"],
    [""],
    ["a".repeat(201)],
    ["bad\nname.md"],
  ])("rejects the path %j → bad_path", (path) => {
    expect(codeOf(() => validateSkillFiles(skill([{ path, content: "x" }])))).toBe("bad_path");
  });

  it("rejects the same path twice, whatever the case → bad_path", () => {
    expect(codeOf(() => validateSkillFiles(skill([{ path: "a.md", content: "1" }, { path: "A.md", content: "2" }])))).toBe("bad_path");
  });

  it("20 files are fine, 21 are too_many_files", () => {
    const extra = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `references/f${i}.md`, content: "x" }));
    expect(validateSkillFiles(skill(extra(19))).files).toHaveLength(20);
    expect(codeOf(() => validateSkillFiles(skill(extra(20))))).toBe("too_many_files");
  });

  it("a file of exactly 200 KB is fine, one byte more is file_too_large (bytes, not characters)", () => {
    const max = SKILL_LIMITS.maxFileBytes;
    expect(validateSkillFiles(skill([{ path: "big.md", content: "x".repeat(max) }])).totalBytes).toBeGreaterThan(max);
    expect(codeOf(() => validateSkillFiles(skill([{ path: "big.md", content: "x".repeat(max + 1) }])))).toBe("file_too_large");
    // "é" is one character and two bytes.
    expect(codeOf(() => validateSkillFiles(skill([{ path: "big.md", content: "é".repeat(max / 2 + 1) }])))).toBe("file_too_large");
  });

  it("more than 1 MB in total → skill_too_large", () => {
    const chunk = "x".repeat(190 * 1024);
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `references/f${i}.md`, content: chunk }));
    expect(codeOf(() => validateSkillFiles(skill(files)))).toBe("skill_too_large");
    expect(validateSkillFiles(skill(files.slice(0, 5))).files).toHaveLength(6);
  });

  it("binary content → not_text", () => {
    expect(codeOf(() => validateSkillFiles(skill([{ path: "logo.png", content: `PNG${String.fromCharCode(0)}${String.fromCharCode(1)}` }])))).toBe("not_text");
    expect(validateSkillFiles(skill([{ path: "tabs.md", content: "a\tb\r\nc" }])).files).toHaveLength(2);
  });
});

describe("starter skill, slugs, tool text", () => {
  it.each([
    ["Sharpen a marketing message", "sharpen-a-marketing-message"],
    ["  Café  résumé!! ", "cafe-resume"],
    ["Q4 — launch / plan", "q4-launch-plan"],
    ["???", "skill"],
    ["x".repeat(100), "x".repeat(64)],
  ])("slugify(%j) → %j", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it("the starter SKILL.md written from a title is itself a valid skill", () => {
    for (const title of ["Sharpen a marketing message", 'Quote "per store": pricing', "???"]) {
      const result = validateSkillFiles([{ path: "SKILL.md", content: starterSkillMd(title) }]);
      expect(result.name).toBe(slugify(title));
      expect(result.heading).toBe(title);
      expect(result.description).toContain(title);
    }
  });

  it("the sign-up starter skill is valid, short, and names only tools that exist", () => {
    const result = validateSkillFiles([{ path: "SKILL.md", content: STARTER_SKILL_MD }]);
    expect(result.name).toBe("how-to-use-openkt");
    expect(result.heading).toBe("How to use OpenKT");
    expect(result.totalBytes).toBeLessThan(2500);
    const known = ["kt_session_start", "kt_recall", "kt_save_memory", "kt_session_end", "kt_list_projects", "kt_list_skills", "kt_get_skill", "kt_save_skill"];
    for (const tool of STARTER_SKILL_MD.match(/kt_[a-z_]+/g) ?? []) expect(known).toContain(tool);
  });

  it("renders SKILL.md first, then each other file under a `--- path ---` header", () => {
    const text = renderSkillText([
      { path: "SKILL.md", content: GOOD },
      { path: "references/voice.md", content: "Short sentences.\n" },
    ]);
    expect(text.startsWith("---\nname: sharpen-message")).toBe(true);
    expect(text).toContain("\n\n--- references/voice.md ---\nShort sentences.");
  });

  it("the MCP server instructions mention skills and stay within 2 KB", () => {
    expect(SERVER_INSTRUCTIONS).toContain("kt_list_skills");
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(2048);
  });
});
