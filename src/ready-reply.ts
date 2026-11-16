/**
 * What a lane's READY posts back to the owner's own Discord message, decided from files only (no network).
 *
 * Allow-list: only a lane whose brief says `public: true` on a line of its own (above `## STOP WHEN`) gets a reply.
 * The lead writes that line when it launches public-material work; every other lane stays inbox-only, whatever its
 * folder holds. A public lane gets a reply when, also:
 *   - its brief names a message id that the inbound log (`<stateDir>/inbound.log`, lines
 *     `INBOUND discord <channel> <id> from=owner …`) records as the owner's. Ids under the brief's `## STOP WHEN`
 *     block are skipped: every parukuri brief cites the same standing order there, which is not this lane's message.
 *   - its results folder `<home>/results/<key>/` has `결과.md`; the reply text is that file's first prose paragraph
 *     (not a heading, table, list or quote, and not the one quoting the original message back).
 *   - the two things posted, that paragraph and the picture's text read by OCR (`readPicture`), hold no client name
 *     (matched by salted hash, `loadNameHashes`: no name is on this machine), registration number or case-folder path
 *     (`caseReason`). A picture that cannot be read keeps the lane inbox-only.
 * The picture is `비교_390.png` (the phone-width cut) when present, else `비교.png`, else none. Nothing else in the
 * folder is posted, so nothing else is read.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Fenced code and HTML comments: never posted, even when a blank line splits them into two "paragraphs". */
const HIDDEN_BLOCK = /^```[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))|<!--[\s\S]*?(?:-->|(?![\s\S]))/gm;
/** Case and private folders, the same set `private-read-deny.sb` keeps away from non-subscription models. */
const CASE_PATH =
  /LegalData|sanjai-agent(?:-wt\/[^/\s]+)?\/(?:cases|private|library\/sources\/private)(?:\/|\b)|\.omp-dori\/quarantine/;
/**
 * Resident (7th digit 1-4) and foreigner (5-8) registration numbers led by a real YYMMDD date, with any one non-digit
 * between the halves (OCR turns a dash into `.`, `_`, `~`). Two looks, either blocks: on the text with whitespace
 * removed, with no digit guard (a neighbouring number such as `2026` glues on there); on the NFKC text with spaces
 * allowed inside the number and digits not allowed right next to it.
 */
const RRN_FLAT = /\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[^\d]?[1-8]\d{6}/;
const RRN_SPACED =
  /(?<!\d)\d\s*\d\s*(?:0\s*[1-9]|1\s*[0-2])\s*(?:0\s*[1-9]|[12]\s*\d|3\s*[01])\s*[^\d\s]?\s*[1-8](?:\s*\d){6}(?!\d)/;
const INVISIBLE = /\u034f|[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

const MSG_ID = /\b1[0-9]{17,19}\b/g;
const MAX_TEXT = 1900;

export type Owner = { readonly id: string; readonly channel: string };
export type Plan =
  | { readonly post: true; readonly owner: Owner; readonly text: string; readonly image?: string }
  | { readonly post: false; readonly why: string };

/** The scheme a hash file must declare: HMAC-SHA256 under the salt, of the squeezed name (see `squeeze`), hex. */
export const NAME_HASH_SCHEME = "hmac-sha256:nfkc-lower-nospace:v1";

/** Client names as salted hashes: no name is kept, only the hashes and the name lengths (in code points) to try. */
export type NameHashes = {
  readonly salt: string;
  readonly lengths: readonly number[];
  readonly hashes: ReadonlySet<string>;
};

/**
 * The salt file's text (surrounding whitespace dropped), undefined when it is missing, empty, or readable by anyone
 * but its owner (mode wider than 600): a salt others can read lets them test guessed names against the hashes.
 */
function loadSalt(path: string): string | undefined {
  try {
    if ((statSync(path).mode & 0o077) !== 0) return undefined;
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The hash file the macmini exports (`{"scheme", "lengths": [2, 3, 4], "hashes": ["<hex>", …]}`) with its salt file.
 * Undefined when either is missing or broken, the scheme differs, or nothing is listed: then nothing can be checked.
 */
export function loadNameHashes(hashFile: string, saltFile: string): NameHashes | undefined {
  const salt = loadSalt(saltFile);
  if (!salt || !existsSync(hashFile)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(hashFile, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { scheme, lengths, hashes } = raw as Record<string, unknown>;
    if (scheme !== NAME_HASH_SCHEME || !Array.isArray(lengths) || !Array.isArray(hashes)) return undefined;
    const lens = lengths.filter((n): n is number => Number.isInteger(n) && n >= 2 && n <= 32);
    const set = new Set(hashes.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)));
    // A file that lists no length or no hash judges nothing: the same as no file.
    if (!lens.length || !set.size || lens.length !== lengths.length || set.size !== hashes.length) return undefined;
    return { salt, lengths: lens, hashes: set };
  } catch {
    return undefined;
  }
}

/** `s` as compared: NFKC, lower case, with invisible characters and all whitespace removed. */
const squeeze = (s: string) => s.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, "").toLowerCase();

/** The salted hash of an already squeezed name, as the macmini's export script computes it. */
export const nameHash = (salt: string, squeezed: string) =>
  createHmac("sha256", salt).update(squeezed, "utf8").digest("hex");

/** Whether any run of `lengths` code points in the squeezed `flat` hashes to a listed name. */
function holdsName(flat: string, names: NameHashes): boolean {
  const chars = Array.from(flat);
  for (const len of names.lengths) {
    for (let i = 0; i + len <= chars.length; i++) {
      if (names.hashes.has(nameHash(names.salt, chars.slice(i, i + len).join("")))) return true;
    }
  }
  return false;
}

/**
 * Why `text` (one of the two things posted) must not go out, or undefined. A name counts anywhere, glued to a label
 * ("성명가나다", what OCR makes of a form) or spaced out ("가 나 다"): a wrong block only costs an automatic reply.
 */
function caseReason(label: string, text: string, names: NameHashes): string | undefined {
  const flat = squeeze(text);
  if (CASE_PATH.test(text.normalize("NFKC"))) return `${label} points into case folders`;
  if (RRN_FLAT.test(flat) || RRN_SPACED.test(text.normalize("NFKC").replace(INVISIBLE, ""))) {
    return `${label} holds a registration number`;
  }
  if (holdsName(flat, names)) return `${label} holds a client name`;
  return undefined;
}

/** How many lines at the top of a brief make its header, where plan-fable.sh writes `public: true`. */
const HEADER_LINES = 5;

/** Whether the brief's header (its first HEADER_LINES lines) marks the lane public with a line `public: true`. */
const isPublic = (brief: string) => brief.split("\n", HEADER_LINES).some((line) => /^public:\s*true\s*$/.test(line));

/** The owner messages in the inbound log, id -> channel. */
export function ownerMessages(inboundLog: string): Map<string, string> {
  const owners = new Map<string, string>();
  if (!existsSync(inboundLog)) return owners;
  for (const line of readFileSync(inboundLog, "utf8").split("\n")) {
    const m = /^INBOUND discord (\d+) (\d+) from=owner /.exec(line);
    if (m?.[1] && m[2]) owners.set(m[2], m[1]);
  }
  return owners;
}

/** The first id in the brief (above `## STOP WHEN`) that the owner posted. */
export function ownerMessageOf(brief: string, owners: ReadonlyMap<string, string>): Owner | undefined {
  const aboveStopWhen = brief.split(/^## STOP WHEN/m)[0] ?? brief;
  for (const id of aboveStopWhen.match(MSG_ID) ?? []) {
    const channel = owners.get(id);
    if (channel) return { id, channel };
  }
  return undefined;
}

/**
 * The paragraph a result file leads with, cut to fit one Discord message: the first prose paragraph under a heading
 * named 한 줄, 요약 or 결론 when there is one, else the first prose paragraph. Paragraphs containing any of `skip`
 * (the original message id quoted back, the lane's own results path) say nothing to the owner and are passed over.
 */
export function firstParagraph(result: string, skip: readonly string[] = []): string | undefined {
  // Hidden blocks go first, so a heading inside a code fence never picks the reply.
  const visible = result.replace(HIDDEN_BLOCK, "\n\n");
  const summary = visible.split(/^#{1,6} .*(?:한 줄|요약|결론).*$/m)[1];
  if (summary !== undefined) {
    const lead = firstParagraph(summary.split(/^#{1,6} /m)[0] ?? "", skip);
    if (lead) return lead;
  }
  for (const block of visible.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(#|\||[-*>] |\d+\. |```|<!--)/.test(text)) continue;
    if (skip.some((s) => text.includes(s))) continue;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (결과.md에 이어짐)` : text;
  }
  return undefined;
}

export function pictureOf(dir: string): string | undefined {
  for (const name of ["비교_390.png", "비교.png"]) if (existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}

/**
 * The text in a picture by OCR (`tesseract`, Korean and English; DORI_TESSERACT overrides), undefined if it fails or
 * cannot read Korean: tesseract exits 0 when the `kor` data is missing and reads English only, which would drop a
 * Korean name, so a `Failed loading language` line on stderr counts as unreadable too.
 */
export function ocrPicture(path: string): string | undefined {
  try {
    const r = Bun.spawnSync([process.env["DORI_TESSERACT"] ?? "tesseract", path, "-", "-l", "kor+eng"]);
    if (r.exitCode !== 0 || /Failed loading language/i.test(r.stderr.toString())) return undefined;
    return r.stdout.toString();
  } catch {
    return undefined;
  }
}

export function planReply(input: {
  readonly brief: string;
  readonly resultsDir: string;
  readonly owners: ReadonlyMap<string, string>;
  readonly caseNames: NameHashes | undefined;
  /** The text in the picture to be posted, undefined when it cannot be read (see `ocrPicture`). */
  readonly readPicture: (path: string) => string | undefined;
}): Plan {
  if (!isPublic(input.brief)) return { post: false, why: "the brief is not marked public: true" };
  const owner = ownerMessageOf(input.brief, input.owners);
  if (!owner) return { post: false, why: "the brief names no owner message" };
  if (!input.caseNames)
    return { post: false, why: "no readable client-name hashes and salt, so the reply cannot be checked" };
  const resultFile = join(input.resultsDir, "결과.md");
  if (!existsSync(resultFile)) return { post: false, why: `no ${resultFile}` };
  const text = firstParagraph(readFileSync(resultFile, "utf8"), [owner.id, input.resultsDir]);
  if (!text) return { post: false, why: "결과.md has no prose paragraph" };
  const inText = caseReason("the reply text", text, input.caseNames);
  if (inText) return { post: false, why: `case material: ${inText}` };
  const image = pictureOf(input.resultsDir);
  if (!image) return { post: true, owner, text };
  const seen = input.readPicture(image);
  if (seen === undefined) return { post: false, why: `${image} could not be read to check it` };
  const inPicture = caseReason(`text in ${image}`, seen, input.caseNames);
  if (inPicture) return { post: false, why: `case material: ${inPicture}` };
  return { post: true, owner, text, image };
}
