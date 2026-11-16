/**
 * Our own Discord result posts and the owner's replies to them.
 *
 * `dori send discord` appends one line per post to `<stateDir>/discord-sent.log`: `<post id>\t<lane>\t<kind>`, the
 * lane from DORI_LANE and the kind from `--kind seo|card|video|legal|all`; a post sent without `--kind` (a status
 * line, an answer) is logged as `-`. Only a reply to a post logged with a kind goes into the harness home's owner
 * ledger (`반복지적.md`), verbatim through `addEntry` under that kind: the ledger feeds writing-model requests, so an
 * approval, a payment answer or a case remark under any other post must never reach it. A reply to a post not in the
 * log (the other Mac's bot, someone else, an older post) stays out until that sender writes the same log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addEntry, KINDS, ledgerPath } from "../../../../../src/writer-request.ts";
import type { DiscordInbound } from "./discord-inbound-api.ts";
import { MessengerError } from "./http.ts";

const sentLog = (stateDir: string): string => join(stateDir, "discord-sent.log");

/** `--kind` for a post: a writing kind or `all` marks a result post; none gives `-`. */
export const postKind = (kind: string | undefined): string => {
  if (kind === undefined || kind === "") return "-";
  if (kind !== "all" && !KINDS.some((k) => k === kind))
    throw new MessengerError(`--kind must be ${KINDS.join(", ")} or all, not ${kind}`, 0);
  return kind;
};

export const recordSent = (stateDir: string, postId: string, lane: string | undefined, kind: string): void => {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(sentLog(stateDir), `${postId}\t${lane?.trim() || "-"}\t${kind}\n`);
};

/** The kind a post was sent with (`-` for a non-result post), or undefined when it is not in the log. */
export const sentKind = (stateDir: string, postId: string): string | undefined => {
  if (!existsSync(sentLog(stateDir))) return undefined;
  for (const line of readFileSync(sentLog(stateDir), "utf8").split("\n")) {
    const [id, , kind] = line.split("\t");
    if (id === postId && kind) return kind;
  }
  return undefined;
};

/**
 * The ledger line added for an owner reply to one of our result posts, or undefined when the message is not such a
 * reply, has no words, or the home has no ledger. A message already in the ledger is left as it is.
 */
export const ledgerReply = (
  home: string,
  stateDir: string,
  ownerId: string,
  message: DiscordInbound,
): string | undefined => {
  const post = message.replyTo;
  if (!post || post.author === ownerId || message.text.trim() === "") return undefined;
  const kind = sentKind(stateDir, post.id);
  if (kind === undefined || kind === "-" || !existsSync(ledgerPath(home))) return undefined;
  if (readFileSync(ledgerPath(home), "utf8").includes(` · msg ${message.message} · `)) return undefined;
  return addEntry({
    home,
    kinds: kind,
    msg: message.message,
    text: message.text,
    post: post.id,
  });
};
