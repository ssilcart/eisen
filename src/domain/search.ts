// Global fuzzy search (S19): pure, in memory, no dependency. Text is folded
// (NFD, no diacritics, lowercase) so "compañía" = "compania"; every query
// token must match the title, the description or the tags; `#word` tokens
// match tags only, by prefix; other tokens match by substring and, when no
// field contains them, by typo tolerance (optimal string alignment distance)
// against each word of the fields.
import { fold } from "./tags.ts";
import type { Status } from "./task.ts";

export type SearchField = "title" | "tags" | "description";

/** What `search` reads from a task; extra properties are passed through. */
export interface Searchable {
  id: number;
  title: string;
  description: string | null;
  tags: readonly string[];
  status: Status;
  position: number;
}

export interface SearchMatch<T extends Searchable> {
  task: T;
  /** Higher is better; only meaningful relative to other matches of the same query. */
  score: number;
  /** Fields any token matched, in title, tags, description order. */
  fields: SearchField[];
}

interface Entry<T extends Searchable> {
  task: T;
  /** Folded text per field, in FIELDS order; tags is one string per tag. */
  title: string;
  tags: string[];
  description: string;
  /** Unique words per field, computed the first time a token needs typo tolerance. */
  words: [string[], string[], string[]] | null;
}

/** Folded fields of a task list, built once and reusable across queries. */
export interface SearchIndex<T extends Searchable> {
  readonly entries: readonly Entry<T>[];
}

const FIELDS: readonly SearchField[] = ["title", "tags", "description"];
/** Ranking (S19): the field first, then how well it matched. */
const FIELD_WEIGHT = [3, 2, 1] as const;
const EXACT = 4;
const PREFIX = 3;
const SUBSTRING = 2;
const FUZZY = 1;
const NONE = 0;

type Token = { tag: true; text: string } | { tag: false; text: string; typos: number };

export function prepareSearch<T extends Searchable>(tasks: readonly T[]): SearchIndex<T> {
  return {
    entries: tasks.map((task) => ({
      task,
      title: fold(task.title),
      tags: task.tags.map(fold),
      description: task.description ? fold(task.description) : "",
      words: null,
    })),
  };
}

/**
 * Tasks matching every token of `query`, best first: higher score, then open
 * before done, then position and id. An empty query (or one with no letters
 * or digits) filters nothing: every task, in input order, score 0.
 */
export function search<T extends Searchable>(source: readonly T[] | SearchIndex<T>, query: string): SearchMatch<T>[] {
  const index = isIndex(source) ? source : prepareSearch(source);
  const tokens = parseQuery(query);
  if (tokens.length === 0) return index.entries.map((e) => ({ task: e.task, score: 0, fields: [] }));
  // Typo checks repeat the same words across tasks: remember them per token.
  const memo = tokens.map(() => new Map<string, boolean>());
  const out: SearchMatch<T>[] = [];
  entries: for (const entry of index.entries) {
    let score = 0;
    let matched = 0; // bit per field, FIELDS order
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t]!;
      const kinds = token.tag ? [NONE, tagPrefix(entry.tags, token.text), NONE] : textKinds(entry, token, memo[t]!);
      let best = 0;
      for (let f = 0; f < 3; f++) {
        const kind = kinds[f]!;
        if (kind === NONE) continue;
        matched |= 1 << f;
        best = Math.max(best, FIELD_WEIGHT[f as 0 | 1 | 2] * 10 + kind);
      }
      if (best === 0) continue entries;
      score += best;
    }
    out.push({ task: entry.task, score, fields: FIELDS.filter((_, f) => matched & (1 << f)) });
  }
  return out.sort(
    (a, b) =>
      Number(a.task.status === "done") - Number(b.task.status === "done") ||
      b.score - a.score ||
      a.task.position - b.task.position ||
      a.task.id - b.task.id,
  );
}

function isIndex<T extends Searchable>(source: readonly T[] | SearchIndex<T>): source is SearchIndex<T> {
  return !Array.isArray(source);
}

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Folded tokens; leading/trailing punctuation is dropped ("features:" → "features"). */
function parseQuery(query: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of fold(query).split(/\s+/)) {
    const tag = raw.startsWith("#");
    const text = (tag ? raw.slice(1) : raw).replace(EDGE_PUNCTUATION, "");
    if (!text) continue;
    if (tag) {
      tokens.push({ tag: true, text });
      continue;
    }
    const length = Array.from(text).length;
    tokens.push({ tag: false, text, typos: length < 4 ? 0 : length < 8 ? 1 : 2 });
  }
  return tokens;
}

function tagPrefix(tags: readonly string[], text: string): number {
  let best = NONE;
  for (const tag of tags) {
    if (tag === text) return EXACT;
    if (tag.startsWith(text)) best = PREFIX;
  }
  return best;
}

/** Match kind per field for a plain token: substring kinds first, typos only if none. */
function textKinds<T extends Searchable>(entry: Entry<T>, token: Token & { tag: false }, memo: Map<string, boolean>): number[] {
  const kinds = [occurrence(entry.title, token.text), NONE, occurrence(entry.description, token.text)];
  for (const tag of entry.tags) kinds[1] = Math.max(kinds[1]!, occurrence(tag, token.text));
  if (kinds[0] || kinds[1] || kinds[2] || token.typos === 0) return kinds;
  entry.words ??= [words(entry.title), unique(entry.tags.flatMap(words)), words(entry.description)];
  for (let f = 0; f < 3; f++) {
    for (const word of entry.words[f]!) {
      if (Math.abs(word.length - token.text.length) > token.typos) continue;
      let close = memo.get(word);
      if (close === undefined) {
        close = osaDistance(token.text, word, token.typos) <= token.typos;
        memo.set(word, close);
      }
      if (close) {
        kinds[f] = FUZZY;
        break;
      }
    }
  }
  return kinds;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** EXACT (a whole word), PREFIX (start of a word), SUBSTRING or NONE. */
function occurrence(haystack: string, needle: string): number {
  let best = NONE;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    const starts = i === 0 || !WORD_CHAR.test(haystack[i - 1]!);
    if (!starts) {
      best = Math.max(best, SUBSTRING);
      continue;
    }
    const end = i + needle.length;
    if (end === haystack.length || !WORD_CHAR.test(haystack[end]!)) return EXACT;
    best = PREFIX;
  }
  return best;
}

function words(text: string): string[] {
  return unique(text.split(/[^\p{L}\p{N}]+/u));
}

function unique(list: string[]): string[] {
  return [...new Set(list)].filter(Boolean);
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent
 * transpositions, each substring edited once). Returns `max + 1` as soon as
 * the distance is known to exceed `max`.
 */
export function osaDistance(a: string, b: string, max: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  if (n === 0 || m === 0) return Math.max(n, m);
  let before = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [before, prev, cur] = [prev, cur, before];
  }
  return Math.min(prev[m]!, max + 1);
}
