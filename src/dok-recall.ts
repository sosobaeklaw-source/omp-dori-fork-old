/**
 * Recall the case notes (독후감) a brief needs, as oh-my-hermes recalls project memory for a task: rank every note
 * for the brief, keep the best passage of the top notes until a count or character budget would be crossed, and
 * name what the budget left out. The kept passages print as `PATH:START-END` lines that `writer_request --cases`
 * and `DORI_HOME/writer-cases/<kind>.txt` take.
 *
 * A note is ranked by BM25F over two short fields (oh-my-hermes ranks on summary and tags, not on bodies): its
 * headings plus its opening, and the words of its path, since the folder name is the topic (독후감_색인.md says so).
 * Long bodies stay out: they made the longest notes win every brief. A term that more than half the notes hold
 * never counts. A note that other briefs and writer-cases already cite gets a lift by how often it was cited.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type Concept, expandQuery } from "./onto-concepts.ts";
import { caseReason, type NameHashes } from "./ready-reply.ts";
import { type Bag, bestPassage, type Note, type Passage, terms } from "./dok-passage.ts";
import { readStudyDirs } from "./study-dirs.ts";

// Copies, drafts and backups of a note, the requests, prompts and run logs that made it, and the working folders
// its drafts sit in: the index skips most of them too, and they crowd out the note itself. A folder or file name
// holding any of these is left out.
const COPY =
  /bak|backup|_old|_v\d|_r\d+\.md$|원본\.md$|before|사본|백업|보관|보존|사용금지_|미사용|초안|초고|후보|검토중|(?:검수|수정|교정|대조|조사|정정)전|요청|지시\.md$|브리프|프롬프트|입력기록|stdout|한도종료|_읽기자료|failed|^attempt$|^_?work$|^dok-work$|^src$|^pack$|^__none__$/i;
// Reading copies other lanes gathered from elsewhere (the same notes, a line or two apart).
const GATHERED = /(?:^|\/)research\/local$/;
// A phone number (pii_guard.py's pattern, with no digit glued on either side so long ids do not match).
const PHONE = /(?<!\d)0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)/;
const CITE = /[~/\w.-]*sobaegi-lead\/results\/[^\s)`'"]*독후감[^\s)`'":]*\.md/gu;

const bagOf = (text: string): Bag => {
  const bag: Bag = new Map();
  for (const t of terms(text)) bag.set(t, (bag.get(t) ?? 0) + 1);
  return bag;
};
const sizeOf = (bag: Bag): number => [...bag.values()].reduce((a, b) => a + b, 0);

/**
 * Every `*독후감*.md` under `root`, one per content, copies and backups left out. Of files with the same text (md5)
 * the one with the shortest path below `root` stays, the alphabetically first on a tie, whatever order the disk lists
 * them in. Notes come back in path order. With `allow`, only those top folders of `root` are read at all — the
 * sanjai-agent allowlist `readStudyDirs` returns, never other folders or loose files under the root.
 */
export function loadNotes(root: string, allow?: readonly string[]): Note[] {
  const only = allow === undefined ? undefined : new Set(allow);
  const kept = new Map<string, Note>();
  const below = (path: string): string => relative(root, path);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const name = e.name.normalize("NFC");
      const path = join(dir, e.name);
      if (name.startsWith(".") || name === "node_modules" || COPY.test(name) || GATHERED.test(below(path))) continue;
      // An allowlist means its top folders are the only thing read under the root: no other folder, no loose file.
      if (only !== undefined && dir === root && !(e.isDirectory() && only.has(name))) continue;
      if (e.isDirectory()) walk(path);
      else if (name.endsWith(".md") && name.includes("독후감") && !name.includes("색인")) {
        const text = readFileSync(path, "utf8");
        const sum = createHash("md5").update(text).digest("hex");
        const nfc = path.normalize("NFC");
        const other = kept.get(sum);
        // Of two files with the same text, the path below the root that is shorter, or as long and first, stays.
        const [a, b] = [below(nfc), other ? below(other.path) : ""];
        if (other && !(a.length < b.length || (a.length === b.length && a < b))) continue;
        const lines = text.split("\n");
        const heads = lines.filter((l) => /^#{1,3} /.test(l)).join(" ");
        kept.set(sum, {
          path: nfc,
          lines,
          head: bagOf(`${heads} ${text.slice(0, 800)}`),
          tag: bagOf(below(nfc).replace(/[-_/.]/g, " ")),
          sum,
        });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return [...kept.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How often each note (by md5 of its text) is cited in DORI_HOME/briefs and DORI_HOME/writer-cases, `skip` aside. */
export function citations(home: string, skip?: string): Map<string, number> {
  const count = new Map<string, number>();
  const self = skip && existsSync(skip) ? realpathSync(resolve(skip)) : undefined;
  for (const sub of ["briefs", "writer-cases"]) {
    const dir = join(home, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const file = join(dir, f);
      if (!/\.(md|txt)$/.test(f) || realpathSync(file) === self) continue;
      const cited = new Set<string>();
      for (const c of readFileSync(file, "utf8").match(CITE) ?? []) {
        const path = c.startsWith("~/") ? join(homedir(), c.slice(2)) : c.slice(c.indexOf("/"));
        if (existsSync(path)) cited.add(createHash("md5").update(readFileSync(path, "utf8")).digest("hex"));
      }
      for (const sum of cited) count.set(sum, (count.get(sum) ?? 0) + 1);
    }
  }
  return count;
}

const idf = (n: number, df: number): number => Math.log(1 + (n - df + 0.5) / (df + 0.5));
// BM25 saturation with k1 = 1.2; length is normalised in whole multiples of the average, as oh-my-hermes does.
const sat = (w: number): number => (w * 2.2) / (w + 1.2);
const norm = (len: number, avg: number): number => 0.25 + 0.75 * Math.max(1, avg > 0 ? Math.floor(len / avg) : 1);

export interface Scored {
  readonly note: Note;
  readonly score: number;
}

/** Notes ranked for `query`; a note cited `c` times (by md5, see `citations`) scores 1 + ln(1 + c) times higher. */
export function rank(query: string, notes: readonly Note[], cited: ReadonlyMap<string, number> = new Map()): Scored[] {
  const n = notes.length;
  const df = new Map<string, number>();
  for (const note of notes)
    for (const t of new Set([...note.head.keys(), ...note.tag.keys()])) df.set(t, (df.get(t) ?? 0) + 1);
  const avgHead = notes.reduce((a, x) => a + sizeOf(x.head), 0) / n;
  const avgTag = notes.reduce((a, x) => a + sizeOf(x.tag), 0) / n;
  // With fewer than three notes, "more than half" would drop every shared word.
  const asked = [...new Set(terms(query))].filter((t) => (df.get(t) ?? 0) > 0 && (n < 3 || df.get(t)! * 2 <= n));
  return notes
    .map((note) => {
      const h = norm(sizeOf(note.head), avgHead);
      const g = norm(sizeOf(note.tag), avgTag);
      let score = 0;
      for (const t of asked) {
        const w = (note.head.get(t) ?? 0) / h + (2 * (note.tag.get(t) ?? 0)) / g;
        if (w > 0) score += sat(w) * idf(n, df.get(t)!);
      }
      return { note, score: score * (1 + Math.log1p(cited.get(note.sum) ?? 0)) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface Recall {
  readonly kept: Passage[];
  /** The next candidates after the budget was spent, as oh-my-hermes lists them under over_budget. */
  readonly over: Passage[];
}

/**
 * Keep passages of the ranked notes in order until `limit` notes or `maxChars` characters would be crossed. Each
 * passage gets at most `maxChars / limit` characters, so one long section never takes the whole budget. A note
 * scoring under `floor` times the score of the first note that gave a passage is not taken, and a passage must share `minHit` of the query's
 * words (see `bestPassage`): a long tail of weakly matching notes is what pulls a 재해경위서 template into a SEO
 * request. The passages go to a writing model, so one holding a client name (matched by salted hash, `names`), a
 * registration number, a phone number or a case-folder path is left out, and so is one whose text a kept or listed
 * passage already has.
 */
export function recall(
  query: string,
  ranked: readonly Scored[],
  limit: number,
  maxChars: number,
  names: NameHashes,
  { floor = 0, minHit = 0 }: { floor?: number; minHit?: number } = {},
): Recall {
  const kept: Passage[] = [];
  const over: Passage[] = [];
  const seen = new Set<string>();
  let top: number | undefined;
  let used = 0;
  for (const { note, score } of ranked) {
    if (top !== undefined && score < top * floor) break;
    const p = bestPassage(note, query, Math.floor(maxChars / limit), minHit);
    if (!p) continue;
    top ??= score;
    const text = note.lines.slice(p.start - 1, p.end).join("\n");
    if (seen.has(text)) continue;
    seen.add(text);
    if (caseReason("", text, names) || PHONE.test(text)) continue;
    if (over.length === 0 && kept.length < limit && used + p.chars <= maxChars) {
      kept.push(p);
      used += p.chars;
    } else if (over.push(p) >= limit) break;
  }
  return { kept, over };
}

/** A brief's own words: everything above the harness's standing sections. */
export const briefQuery = (brief: string): string => brief.split(/\n## (?:Lane rules|STOP WHEN|Lessons for )/)[0]!;

/** `~/`-relative when under the home, so the lines read the same on both Macs. */
export const label = (p: Passage): string => {
  const home = homedir();
  const path = p.path.startsWith(`${home}/`) ? `~/${p.path.slice(home.length + 1)}` : p.path;
  return `${path}:${p.start}-${p.end}`;
};

export interface Recalled {
  /** `~/PATH:START-END` per kept passage, best first. */
  readonly specs: string[];
  /** The ontology concepts that widened the query (`expandQuery`'s `used`). */
  readonly onto: string[];
}

/** Defaults for a writing request: a few strong passages, not a long tail (see `recall`). */
export const RECALL = { limit: 6, maxChars: 6000, floor: 0.5, minHit: 2 } as const;

/**
 * The passages a writing request needs for `text` (its task and sheet): the query widened by the ontology's
 * concepts, ranked over the notes under `root`'s allowed top folders (`allow`, else the run-time sanjai-agent
 * allowlist; with no readable allowlist nothing is recalled), kept within the budget, client names and case paths
 * left out (`recall`).
 */
export function recallFor(
  home: string,
  text: string,
  names: NameHashes,
  opts: {
    root: string;
    concepts: readonly Concept[];
    limit: number;
    maxChars: number;
    floor?: number;
    minHit?: number;
    allow?: readonly string[];
  },
): Recalled {
  const { query, used } = expandQuery(text, opts.concepts);
  const notes = loadNotes(opts.root, opts.allow ?? readStudyDirs() ?? []);
  if (notes.length === 0) return { specs: [], onto: used };
  const { kept } = recall(query, rank(query, notes, citations(home)), opts.limit, opts.maxChars, names, opts);
  return { specs: kept.map(label), onto: used };
}
