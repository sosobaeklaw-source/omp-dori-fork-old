/**
 * The words a case note (독후감) is matched by, and the one passage of a note a query calls for. `dok-recall.ts`
 * ranks the notes and keeps the passages within its budget.
 */
import { caseLines } from "./writer-request.ts";

const COMMON = new Set(
  "the and for are not our you was its can all use run to of in on is it be as at by or an if do no we that this with from have will when your their before after into only must should work using then fix check make add update new also any need keep get see md txt png json html http https com www 독후감".split(
    " ",
  ),
);
// Same particle stripping as lesson-match.ts, so "독후감을" and "독후감" are one word.
const PARTICLE =
  /^(\p{Script=Hangul}{2,}?)(?:에서|으로|까지|부터|에게|한테|처럼|보다|은|는|이|가|을|를|에|의|도|로|와|과|만)$/u;

/** Words of `text`: Korean words keep their two-letter pieces too, since Korean compounds have no spaces. */
export function terms(text: string, pieces = true): string[] {
  const out: string[] = [];
  for (const raw of text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\p{N}+$/u.test(raw)) continue;
    if (/\p{Script=Hangul}/u.test(raw)) {
      const w = PARTICLE.exec(raw)?.[1] ?? raw;
      if (w.length < 2 || COMMON.has(w)) continue;
      out.push(w);
      if (pieces && w.length > 2) for (let i = 0; i + 2 <= w.length; i++) out.push(w.slice(i, i + 2));
    } else if (raw.length >= 3 && !COMMON.has(raw)) out.push(raw.slice(0, 6));
  }
  return out;
}

export type Bag = Map<string, number>;

export interface Note {
  readonly path: string;
  readonly lines: readonly string[];
  readonly head: Bag;
  readonly tag: Bag;
  /** md5 of the text: copies of one note share it, and citations are counted by it. */
  readonly sum: string;
}

export interface Passage {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly chars: number;
}

const PATHY = /(?:~\/|\/Users\/|[\w가-힣.-]+\/[\w가-힣.-]+\.(?:md|txt|pdf|hwpx?|json|png))/;
/** Half or more of the section's text lines name a file path: a list of what was read, not a lesson. */
const pathList = (section: readonly string[]): boolean => {
  const text = section.filter((l) => l.trim() && !/^#/.test(l));
  return text.length > 0 && text.filter((l) => PATHY.test(l)).length * 2 >= text.length;
};

/**
 * The note's section (split at `#`–`###` headings) sharing most of the query's words, cut to `maxChars`. Only
 * sections holding a case line (writer-request's `caseLines`) and at least `minHit` of the query's words count, and
 * a section that is mostly file paths (a "읽은 것" reading list) never does. The cut always keeps the section's first
 * case line, so `writer_request` never refuses the range. A note with no such section gives none.
 */
export function bestPassage(note: Note, query: string, maxChars: number, minHit = 0): Passage | undefined {
  const asked = new Set(terms(query));
  // minHit counts whole words: one compound like 재해경위서 would otherwise count as five hits by its two-letter pieces.
  const whole = new Set(terms(query, false));
  const cuts = [0, ...note.lines.flatMap((l, i) => (i > 0 && /^#{1,3} /.test(l) ? [i] : [])), note.lines.length];
  let best: { start: number; end: number; hit: number } | undefined;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const section = note.lines.slice(cuts[i], cuts[i + 1]);
    if (caseLines({ label: "", lines: section }).length === 0 || pathList(section)) continue;
    const words = terms(section.join("\n"));
    if (new Set(words.filter((t) => whole.has(t))).size < minHit) continue;
    const hit = new Set(words.filter((t) => asked.has(t))).size;
    if (!best || hit > best.hit) best = { start: cuts[i]!, end: cuts[i + 1]!, hit };
  }
  if (!best) return undefined;
  let end = best.start;
  let chars = 0;
  let hasCase = false;
  while (end < best.end && (!hasCase || chars + note.lines[end]!.length + 1 <= maxChars)) {
    hasCase ||= caseLines({ label: "", lines: [note.lines[end]!] }).length > 0;
    chars += note.lines[end++]!.length + 1;
  }
  while (!note.lines[end - 1]!.trim()) chars -= note.lines[--end]!.length + 1;
  return { path: note.path, start: best.start + 1, end, chars };
}
