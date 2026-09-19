/** Words and small derivations for the skill screens. Pure, so the screens stay about layout. */
import { firstName, timeAgo } from '../../api/format';
import { parseFrontmatter, SKILL_MD } from '../../api/skillFiles';
import type { Grant, Id, Skill, SkillFile, SkillFileInput, SkillSummary, SkillVersion } from '../../api/types';

/** "marketing" · "sales / northgate" · "personal" (a skill in nobody's space but its owner's). */
export const spaceLabel = (s: Pick<SkillSummary, 'spaceName'>): string => s.spaceName || 'personal';

/** "you" for the signed-in person, otherwise a first name. */
export const who = (person: { id: Id; name: string }, meId: Id | undefined): string => (person.id === meId ? 'you' : firstName(person.name));

/** "v4 · edited by Ana 2 days ago" — the head of the history. */
export function editedLine(skill: Pick<Skill, 'currentVersion' | 'versions'>, meId: Id | undefined): string {
  const head = skill.versions[0];
  if (!head) return `v${skill.currentVersion}`;
  const verb = head.version === 1 ? 'written' : 'edited';
  return `v${skill.currentVersion} · ${verb} by ${who(head.createdBy, meId)} ${timeAgo(head.createdAt)}`;
}

/** One version in the rail: "Ana · 2 days ago · shorter word limit". */
export const versionLine = (v: SkillVersion, meId: Id | undefined): string => [who(v.createdBy, meId), timeAgo(v.createdAt), v.changeNote].filter(Boolean).join(' · ');

const grantName = (g: Grant): string => (g.pending ? g.subject.email ?? g.subject.name : g.subject.type === 'team' ? g.subject.name.toLowerCase() : firstName(g.subject.name));

/**
 * "marketing can edit · sales can use" — who besides the owner has it.
 * A reader of a skill usually cannot list its grants: then it says who shared it.
 */
export function accessLine(grants: Grant[], skill: Pick<SkillSummary, 'myRole' | 'owner'>, meId: Id | undefined): string {
  const others = grants.filter((g) => g.role !== 'owner');
  if (!grants.length && skill.myRole !== 'owner') return `shared with you by ${who(skill.owner, meId)}`;
  if (!others.length) return skill.owner.id === meId ? 'only you' : `only ${firstName(skill.owner.name)}`;
  const names = (role: 'editor' | 'reader') =>
    others
      .filter((g) => g.role === role)
      .map(grantName)
      .join(', ');
  return [names('editor') && `${names('editor')} can edit`, names('reader') && `${names('reader')} can use`].filter(Boolean).join(' · ');
}

/** The rail's role word: teams are plural ("editors"), people singular. */
export function railRole(g: Grant): string {
  if (g.pending) return `invited · ${g.role}`;
  return g.subject.type === 'team' && g.role !== 'owner' ? `${g.role}s` : g.role;
}

/** The `## ` headings of a skill's instructions: "Voice · Steps · Output". */
export function sectionsOf(skillMd: string): string[] {
  const body = parseFrontmatter(skillMd)?.body ?? skillMd;
  return [...body.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]!);
}

/** The first paragraph under the title: "Rewrite the draft so it sounds like us." */
export function leadOf(skillMd: string): string {
  const body = parseFrontmatter(skillMd)?.body ?? skillMd;
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|[-*+] |\d+[.)] |```|>|\|)/.test(p));
  return para?.replace(/\s+/g, ' ') ?? '';
}

export const mainFile = (files: readonly SkillFileInput[]): SkillFileInput | undefined => files.find((f) => f.path === SKILL_MD);

/**
 * The whole skill as one text, for pasting into any AI tool: SKILL.md first,
 * then every other file under its path, then (optionally) the person's input.
 */
export function skillAsText(files: readonly SkillFileInput[], input = ''): string {
  const main = mainFile(files)?.content.trim() ?? '';
  const rest = files.filter((f) => f.path !== SKILL_MD).map((f) => `---\n\nFile: ${f.path}\n\n${f.content.trim()}`);
  const ask = input.trim() ? [`---\n\nInput:\n\n${input.trim()}`] : [];
  return [main, ...rest, ...ask].join('\n\n') + '\n';
}

/** Files that differ between two sets, for the clipboard when a save conflicts. */
export function changedFiles(mine: readonly SkillFileInput[], base: readonly SkillFileInput[]): SkillFileInput[] {
  return mine.filter((f) => base.find((b) => b.path === f.path)?.content !== f.content);
}

export const sameFiles = (a: readonly SkillFileInput[], b: readonly Pick<SkillFile, 'path' | 'content'>[]): boolean =>
  a.length === b.length && a.every((f, i) => f.path === b[i]!.path && f.content === b[i]!.content);

/** "markdown" · "json" · "text" — the editor's quiet type label. */
export function fileKind(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'md') return 'markdown';
  if (ext === 'yml') return 'yaml';
  if (ext === 'txt' || !ext) return 'text';
  if (ext === 'py') return 'python';
  if (ext === 'js') return 'javascript';
  if (ext === 'ts') return 'typescript';
  if (ext === 'sh') return 'shell';
  return ext;
}

/** What a new file starts with. */
export function starterFor(path: string): string {
  if (!/\.md$/i.test(path)) return '';
  const base = path.split('/').pop()!.replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
  return `# ${base.charAt(0).toUpperCase()}${base.slice(1)}\n\n`;
}

/** Clipboard write that also works where `navigator.clipboard` is missing or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
