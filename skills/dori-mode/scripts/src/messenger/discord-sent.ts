/**
 * Our own Discord posts and the owner's replies to them.
 *
 * `dori send discord` appends one line per post to `<stateDir>/discord-sent.log`: `<post id>\t<lane>\t<kind>`, the
 * lane from DORI_LANE and the kind from `--kind` (`all` when not given). When the owner replies to a post, intake
 * appends his words verbatim to the harness home's owner ledger (`반복지적.md`) through `addEntry`, under the kind that
 * post was sent with. A reply to a post not in the log (the other Mac's bot, or a post older than the log) also goes
 * in as `all`: it then reaches every kind's request, which is better than reaching none.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addEntry, KINDS, ledgerPath } from "../../../../../src/writer-request.ts";
import type { DiscordInbound } from "./discord-inbound-api.ts";
import { MessengerError } from "./http.ts";

const sentLog = (stateDir: string): string => join(stateDir, "discord-sent.log");

/** `--kind` for a post: one of the writing kinds, or `all` (the default). */
export const postKind = (kind: string | undefined): string => {
  if (kind === undefined || kind === "") return "all";
  if (kind !== "all" && !KINDS.some((k) => k === kind))
    throw new MessengerError(`--kind must be ${KINDS.join(", ")} or all, not ${kind}`, 0);
  return kind;
};

export const recordSent = (stateDir: string, postId: string, lane: string | undefined, kind: string): void => {
  appendFileSync(sentLog(stateDir), `${postId}\t${lane?.trim() || "-"}\t${kind}\n`);
};

/** The kind a post was sent with, or undefined when it is not ours or predates the log. */
export const sentKind = (stateDir: string, postId: string): string | undefined => {
  if (!existsSync(sentLog(stateDir))) return undefined;
  for (const line of readFileSync(sentLog(stateDir), "utf8").split("\n")) {
    const [id, , kind] = line.split("\t");
    if (id === postId && kind) return kind;
  }
  return undefined;
};

/**
 * The ledger line added for an owner reply to someone else's post, or undefined when the message is not such a reply,
 * has no words, or the home has no ledger. A message already in the ledger is left as it is.
 */
export const ledgerReply = (
  home: string,
  stateDir: string,
  ownerId: string,
  message: DiscordInbound,
): string | undefined => {
  const post = message.replyTo;
  if (!post || post.author === ownerId || message.text.trim() === "") return undefined;
  const kind = sentKind(stateDir, post.id) ?? "all";
  if (!existsSync(ledgerPath(home))) return undefined;
  if (readFileSync(ledgerPath(home), "utf8").includes(` · msg ${message.message} · `)) return undefined;
  return addEntry({
    home,
    kinds: kind,
    msg: message.message,
    text: message.text,
    post: post.id,
  });
};
