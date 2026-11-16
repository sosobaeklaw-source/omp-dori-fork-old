/**
 * What a lane's READY posts back to the owner's own Discord message, decided from files only (no network).
 *
 * A lane gets a reply when all of these hold:
 *   - its brief names a message id that the inbound log (`<stateDir>/inbound.log`, lines
 *     `INBOUND discord <channel> <id> from=owner …`) records as the owner's. Ids under the brief's `## STOP WHEN`
 *     block are skipped: every parukuri brief cites the same standing order there, which is not this lane's message.
 *   - its results folder `<home>/results/<key>/` has `결과.md`; the reply text is that file's first prose paragraph
 *     (not a heading, table, list or quote, and not the one quoting the original message back).
 *   - the lane is not a case lane (src/case-check.ts, fail closed): nothing in the brief or the results folder holds
 *     case material, and every entry there could be checked.
 * The picture is `비교_390.png` (the phone-width cut) when present, else `비교.png`, else none. Its pixels are read
 * (`readPicture`, OCR) and the text checked the same way; a picture that cannot be read keeps the lane inbox-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { caseReason, caseTextReason } from "./case-check.ts";

export { loadCaseNames } from "./case-check.ts";

/** Fenced code and HTML comments: never posted, even when a blank line splits them into two "paragraphs". */
const HIDDEN_BLOCK = /^```[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))|<!--[\s\S]*?(?:-->|(?![\s\S]))/gm;

const MSG_ID = /\b1[0-9]{17,19}\b/g;
const MAX_TEXT = 1900;

export type Owner = { readonly id: string; readonly channel: string };
export type Plan =
  | { readonly post: true; readonly owner: Owner; readonly text: string; readonly image?: string }
  | { readonly post: false; readonly why: string };

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
  const owner = ownerMessageOf(input.brief, input.owners);
  if (!owner) return { post: false, why: "the brief names no owner message" };
  const resultFile = join(input.resultsDir, "결과.md");
  if (!existsSync(resultFile)) return { post: false, why: `no ${resultFile}` };
  const result = readFileSync(resultFile, "utf8");
  const blocked = caseReason(input.brief, input.resultsDir, input.caseNames);
  if (blocked) return { post: false, why: `case lane: ${blocked}` };
  const text = firstParagraph(result, [owner.id, input.resultsDir]);
  if (!text) return { post: false, why: "결과.md has no prose paragraph" };
  const image = pictureOf(input.resultsDir);
  if (!image) return { post: true, owner, text };
  const seen = input.readPicture(image);
  if (seen === undefined) return { post: false, why: `case lane: ${image} could not be read to check it` };
  const inPicture = caseTextReason(`text in ${image}`, seen, input.caseNames ?? []);
  if (inPicture) return { post: false, why: `case lane: ${inPicture}` };
  return { post: true, owner, text, image };
}
