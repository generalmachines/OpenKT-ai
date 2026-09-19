/**
 * The shape of one team in the sample workspace. The team files hold content
 * only — who said what, in which session, and what the team's pages say — and
 * `build.ts` turns them into the app's sessions, facts, pages and grants.
 */
import type { ContextKind, Role, SessionSource } from '../../types';

/** Someone on a team, named the way the report names them. `me` is the person using the sample. */
export interface ShowcasePerson {
  key: string;
  name: string;
  title: string;
}

export interface ShowcaseSession {
  id: string;
  source: SessionSource;
  /** The app behind a `claude` or `connector` session: "Cowork", "Notion". */
  via?: string;
  title: string;
  /** Who captured it: a person key, or `me`. */
  by: string;
  /** Days ago, and the local time of day. */
  day: number;
  time: string;
  durationSec?: number;
  /** A screenshot's caption and the text read off the image. */
  shot?: { caption: string; text: string };
  /** The facts said in it, in order. Each is one turn of the transcript, in its speaker's words. */
  facts: string[];
  /** A disagreement that surfaced here, kept as an open question. */
  question?: string;
}

export interface ShowcaseFact {
  id: string;
  /** Person key of whoever said it. */
  by: string;
  kind: ContextKind;
  text: string;
  /** The page it feeds. */
  page: string;
  supersededBy?: string;
}

export interface ShowcasePage {
  id: string;
  title: string;
  /** Person keys, as the report credits the page. */
  by: string[];
  /** Where it stands, sentence by sentence, with the facts each sentence rests on. */
  stands: [text: string, facts: string[]][];
  forks?: { topic: string; sides: [person: string, position: string, fact?: string][] }[];
  changes?: { topic: string; now: string; was: string; nowFact?: string; wasFact?: string }[];
  related?: [page: string, why: string][];
}

export interface ShowcaseTeam {
  space: {
    id: string;
    name: string;
    /** As the report's tab names the team: "Sales", "OpenKT". */
    label: string;
    description: string;
    /** The role of the person using the sample. */
    myRole: Role;
    /** Person key of the owner, or `me`. */
    owner: string;
    team: [id: string, name: string];
  };
  /** The report's own counts. */
  stats: { memories: number; people: number; pages: number };
  people: ShowcasePerson[];
  sessions: ShowcaseSession[];
  facts: ShowcaseFact[];
  pages: ShowcasePage[];
}
