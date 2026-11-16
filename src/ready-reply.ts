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
 *   - the two things posted, that paragraph and the picture's text read by OCR (`readPicture`), hold no client name,
 *     registration number or case-folder path (`caseReason`). A picture that cannot be read keeps the lane inbox-only.
 * The picture is `비교_390.png` (the phone-width cut) when present, else `비교.png`, else none. Nothing else in the
 * folder is posted, so nothing else is read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Fenced code and HTML comments: never posted, even when a blank line splits them into two "paragraphs". */
const HIDDEN_BLOCK = /^```[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))|<!--[\s\S]*?(?:-->|(?![\s\S]))/gm;
/** Case and private folders, the same set `private-read-deny.sb` keeps away from non-subscription models. */
const CASE_PATH =
  /LegalData|sanjai-agent(?:-wt\/[^/\s]+)?\/(?:cases|private|library\/sources\/private)(?:\/|\b)|\.omp-dori\/quarantine/;
/** Resident (7th digit 1-4) and foreigner (5-8) registration numbers led by a real YYMMDD date; text has no spaces. */
const RRN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\u2010-\u2015\u2212]?[1-8]\d{6}(?!\d)/;
const INVISIBLE = /\u034f|[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

const MSG_ID = /\b1[0-9]{17,19}\b/g;
const MAX_TEXT = 1900;

export type Owner = { readonly id: string; readonly channel: string };
export type Plan =
  | { readonly post: true; readonly owner: Owner; readonly text: string; readonly image?: string }
  | { readonly post: false; readonly why: string };

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

/** `s` as compared: NFKC, lower case, with invisible characters and all whitespace removed. */
const squeeze = (s: string) => s.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, "").toLowerCase();

/**
 * Why `text` (one of the two things posted) must not go out, or undefined. A name counts anywhere, glued to a label
 * ("성명가나다", what OCR makes of a form) or spaced out ("가 나 다"): a wrong block only costs an automatic reply.
 */
function caseReason(label: string, text: string, names: readonly string[]): string | undefined {
  const flat = squeeze(text);
  if (CASE_PATH.test(text.normalize("NFKC"))) return `${label} points into case folders`;
  if (RRN.test(flat)) return `${label} holds a registration number`;
  if (names.some((n) => squeeze(n).length >= 2 && flat.includes(squeeze(n)))) return `${label} holds a client name`;
  return undefined;
}

/** Whether the brief, above `## STOP WHEN`, marks the lane public with a line `public: true`. */
const isPublic = (brief: string) => /^public:\s*true\s*$/m.test(brief.split(/^## STOP WHEN/m)[0] ?? brief);

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
  const summary = result.split(/^#{1,6} .*(?:한 줄|요약|결론).*$/m)[1];
  if (summary !== undefined) {
    const lead = firstParagraph(summary.split(/^#{1,6} /m)[0] ?? "", skip);
    if (lead) return lead;
  }
  for (const block of result.replace(HIDDEN_BLOCK, "\n\n").split(/\n\s*\n/)) {
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

/** The text in a picture by OCR (`tesseract`, Korean and English; DORI_TESSERACT overrides), undefined if it fails. */
export function ocrPicture(path: string): string | undefined {
  try {
    const r = Bun.spawnSync([process.env["DORI_TESSERACT"] ?? "tesseract", path, "-", "-l", "kor+eng"]);
    return r.exitCode === 0 ? r.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function planReply(input: {
  readonly brief: string;
  readonly resultsDir: string;
  readonly owners: ReadonlyMap<string, string>;
  readonly caseNames: readonly string[] | undefined;
  /** The text in the picture to be posted, undefined when it cannot be read (see `ocrPicture`). */
  readonly readPicture: (path: string) => string | undefined;
}): Plan {
  if (!isPublic(input.brief)) return { post: false, why: "the brief is not marked public: true" };
  const owner = ownerMessageOf(input.brief, input.owners);
  if (!owner) return { post: false, why: "the brief names no owner message" };
  if (!input.caseNames) return { post: false, why: "no readable client-name list, so the reply cannot be checked" };
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
