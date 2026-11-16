/**
 * Whether a lane's brief and results folder hold case material, for the READY reply (src/ready-reply.ts). Fails
 * closed: whatever the check cannot verify blocks, because a wrong block only costs an automatic reply while a client
 * name posted to Discord cannot be taken back. Blocks:
 *   - a case-folder path, a resident or foreigner registration number, or a client name (see `hasName`), in the brief,
 *     in any file or folder name, or in any text file;
 *   - any entry that is hidden, a symbolic link, not a regular file or folder, nested deeper than MAX_DEPTH folders,
 *     or of a type outside TEXT_FILE and IMAGE_FILE (documents, archives, fonts, files with no extension);
 *   - a text file that is too large, holds NUL bytes or is not UTF-8; a picture whose bytes are not that picture type;
 *     a picture whose embedded text (metadata) holds a name or number; anything that cannot be read.
 * Text is compared after NFKC, with zero-width characters dropped and JSON, HTML and percent escapes decoded.
 * Picture pixels are not read here; the one picture that gets posted is read by OCR in planReply.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Case and private folders, the same set `private-read-deny.sb` keeps away from non-subscription models. */
const CASE_PATH =
  /LegalData|sanjai-agent(?:-wt\/[^/\s]+)?\/(?:cases|private|library\/sources\/private)(?:\/|\b)|\.omp-dori\/quarantine/;
/** Resident (7th digit 1-4) and foreigner (5-8) registration numbers led by a real YYMMDD date; any dash or spaces between. */
const RRN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s*[-\u2010-\u2015\u2212]?\s*[1-8]\d{6}(?!\d)/;
const TEXT_FILE =
  /\.(?:md|markdown|txt|json|jsonl|ndjson|html?|xml|svg|csv|tsv|log|out|err|ya?ml|toml|ini|cfg|conf|plist|py|pl|tsx?|jsx?|[cm]js|sh|bash|zsh|css|diff|patch|sql|srt|vtt|rels|hpf)$/i;
/** Picture names, and the bytes a picture starts with (a `.png` saved as WebP is still a picture). */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;
const isPicture = (b: Buffer) =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
  b.subarray(0, 4).toString("latin1") === "GIF8" ||
  (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP");
const MAX_FILES = 500;
const MAX_DEPTH = 5;
const MAX_TEXT_FILE = 5 * 1024 * 1024;
const MAX_TEXT = 20 * 1024 * 1024;
const MAX_IMAGE = 50 * 1024 * 1024;
const INVISIBLE = /\u034f|[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
/** What may follow a two-syllable name and leave it that name: titles, particles, endings, chained. */
const ENDING =
  /^(?:씨|님|군|양)?(?:은|는|이|가|을|를|의|과|와|도|만|에|께|게|서|한테|하고|로|으로|부터|까지|라는|이라|였|이었|다|고|며|랑|이랑|처럼|보다|조차|마저|나|이나|요|에요|예요|입니다)*$/;

type Names = { readonly hangul: ReadonlySet<string>; readonly longest: number; readonly other?: RegExp };

/** The client-name list: a JSON array of names, or one name per line. Undefined when it cannot be read. */
export function loadCaseNames(path: string | undefined): readonly string[] | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    // Anything that opens like JSON is read as JSON, so a broken JSON file fails closed instead of becoming one "name".
    const list: unknown = /^\s*[[{]/.test(raw) ? JSON.parse(raw) : raw.split("\n");
    if (!Array.isArray(list)) return undefined;
    const names = list.filter((n): n is string => typeof n === "string").map((n) => n.trim());
    const kept = names.filter((n) => n.length >= 2);
    // An empty list judges nothing: the same as no list.
    return kept.length ? kept : undefined;
  } catch {
    return undefined;
  }
}

const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

/** `s` as compared: NFKC without invisible characters, followed by its escape-decoded form when that differs. */
function plain(s: string): string {
  const n = s.normalize("NFKC").replace(INVISIBLE, "");
  const decoded = n
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_, d: string) => codePoint(Number(d)))
    .replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  return decoded === n ? n : `${n}\n${decoded.normalize("NFKC").replace(INVISIBLE, "")}`;
}

function compile(list: readonly string[]): Names {
  const hangul = new Set<string>();
  const other: string[] = [];
  for (const raw of list) {
    const name = raw.normalize("NFKC").replace(INVISIBLE, "").trim();
    if (/^[가-힣]+$/.test(name)) hangul.add(name);
    else if (name) other.push(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  }
  const longest = Math.max(0, ...[...hangul].map((n) => n.length));
  if (!other.length) return { hangul, longest };
  return { hangul, longest, other: new RegExp(`(?<![\\p{L}\\p{N}])(?:${other.join("|")})(?![\\p{L}\\p{N}])`, "iu") };
}

/**
 * Whether a client name stands in `s`: a Hangul run (cut at spaces, `_`, `-`, `.` and the like) that starts with a
 * name of three or more syllables, whatever follows ("가나다에게는", "가나다였다", "가나다라마"), or that is a
 * two-syllable name with only a title, particles or an ending after it; or a non-Hangul name as its own word, any
 * case, any spacing. A name inside a run that starts otherwise ("아가나다") does not count.
 */
function hasName(s: string, names: Names): boolean {
  for (const [run] of s.matchAll(/[가-힣]+/g)) {
    for (let n = Math.min(run.length, names.longest); n >= 2; n--) {
      if (names.hangul.has(run.slice(0, n)) && (n >= 3 || ENDING.test(run.slice(n)))) return true;
    }
  }
  return names.other?.test(s) ?? false;
}

function textReason(label: string, text: string, names: Names): string | undefined {
  const s = plain(text);
  if (CASE_PATH.test(s)) return `${label} points into case folders`;
  if (RRN.test(s)) return `${label} holds a registration number`;
  if (hasName(s, names)) return `${label} holds a client name`;
  return undefined;
}

/** The same check for text from elsewhere (the posted picture read by OCR). */
export function caseTextReason(label: string, text: string, names: readonly string[]): string | undefined {
  return textReason(label, text, compile(names));
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const LOOSE = new TextDecoder("utf-8");

/** Why one regular file blocks, or undefined; `addText` counts text bytes against MAX_TEXT. */
function fileReason(path: string, name: string, names: Names, addText: (n: number) => boolean): string | undefined {
  const size = lstatSync(path).size;
  if (IMAGE_FILE.test(name)) {
    if (size > MAX_IMAGE) return `${name} is too large to check`;
    const bytes = readFileSync(path);
    if (!isPicture(bytes)) return `${name} is not the picture its name says`;
    return textReason(name, LOOSE.decode(bytes), names);
  }
  if (!TEXT_FILE.test(name)) return `${name} is not a type the check can read`;
  if (size > MAX_TEXT_FILE) return `${name} is too large to check whole`;
  if (!addText(size)) return "more text than can be checked";
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return `${name} holds binary bytes`;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return `${name} is not UTF-8 text`;
  }
  return textReason(name, text, names);
}

function folderReason(root: string, names: Names): string | undefined {
  let count = 0;
  let text = 0;
  const addText = (n: number) => {
    text += n;
    return text <= MAX_TEXT;
  };
  const queue: [string, number][] = [["", 0]];
  for (const [rel, depth] of queue) {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const name = rel ? join(rel, entry.name) : entry.name;
      if (++count > MAX_FILES) return `more than ${MAX_FILES} files to check`;
      const said = textReason(name, name, names);
      if (said) return said;
      if (entry.name.startsWith(".")) return `${name} is hidden`;
      if (entry.isSymbolicLink()) return `${name} is a symbolic link`;
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) return `${name} is nested deeper than ${MAX_DEPTH} folders`;
        queue.push([name, depth + 1]);
        continue;
      }
      if (!entry.isFile()) return `${name} is not a regular file`;
      const why = fileReason(join(root, name), name, names, addText);
      if (why) return why;
    }
  }
  return undefined;
}

/** Why this lane must stay inbox-only because of case material, or undefined when it may post. */
export function caseReason(brief: string, resultsDir: string, list: readonly string[] | undefined): string | undefined {
  if (!list) return "no readable client-name list, so the lane cannot be judged";
  const names = compile(list);
  try {
    return textReason("brief", brief, names) ?? folderReason(resultsDir, names);
  } catch (error) {
    return `cannot read the results folder whole (${String(error)})`;
  }
}
