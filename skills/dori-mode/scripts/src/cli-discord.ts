/** The Discord Gateway plumbing shared by `dori presence discord` and `dori inbound discord --gateway`. */
import { die, every } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import type { GatewayClock, GatewaySocket } from "./messenger/discord-gateway.ts";
import { type DiscordInbound, discordInbound, formatDiscordInbound } from "./messenger/discord-inbound.ts";
import { discordInboundLive } from "./messenger/discord-inbound-live.ts";
import { discordInboundEnv, fileDiscordInboundStore } from "./messenger/discord-inbound-state.ts";
import { ledgerReply } from "./messenger/discord-sent.ts";
import { fetchHttp } from "./messenger/http.ts";
import { defaultHome } from "../../../../src/test-home.ts";
import { realClock } from "./run.ts";

export const openDiscordSocket = (url: string): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onMessage: (cb) => ws.addEventListener("message", (event) => cb(String(event.data))),
    onClose: (cb) => ws.addEventListener("close", (event) => cb(event.code)),
    onError: (cb) => ws.addEventListener("error", () => cb()),
  };
};

export const discordClock: GatewayClock = {
  now: realClock.now,
  random: Math.random,
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Waits for a Gateway connection to end, closing it on SIGINT or SIGTERM. */
export const untilStopped = async (gateway: { done: Promise<void>; close(): void }): Promise<void> => {
  const stop = () => gateway.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await gateway.done;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    gateway.close();
  }
};

const idList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

/** A voice message's text from the configured transcription hook. */
export type VoiceText = (url: string) => Promise<string>;
/** Marks a transcript so a reader knows the words were machine-heard; DORI_DISCORD_VOICE_PREFIX replaces it. */
export const DEFAULT_VOICE_PREFIX = "[voice transcript] ";
type Inbound = DiscordInbound;

/** Rejects when `ms` passes first; the slow work may keep running, but nothing waits for it any more. */
const within = <T>(ms: number, work: Promise<T>): Promise<T> => {
  const { promise: late, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

/** Fills an empty-text voice message with its transcript; a failure or timeout leaves it as it was and says why. */
export const withVoiceText = async (
  message: Inbound,
  voiceText: VoiceText,
  warn: (line: string) => void,
  opts: { prefix: string; deadlineMs: number },
): Promise<Inbound> => {
  const voice = message.attachments.find((a) => a.voice);
  if (!voice || message.text.trim() !== "") return message;
  try {
    return { ...message, text: opts.prefix + (await within(opts.deadlineMs, voiceText(voice.url))) };
  } catch (e) {
    warn(`WARN transcribe ${message.message}: ${(e as Error).message}`.slice(0, 300));
    return message;
  }
};

/**
 * The intake's emit. Without a transcriber every message prints at once, as before. With one, an empty-text voice
 * message returns a promise: the intake waits for it before the next message and before saving its cursor, so arrival
 * order holds and a crash mid-transcription replays it.
 */
export const voiceEmit =
  (
    print: (message: Inbound) => void,
    voiceText: VoiceText | undefined,
    warn: (line: string) => void,
    opts: { prefix: string; deadlineMs: number },
  ) =>
  (message: Inbound): void | Promise<void> => {
    const heard = voiceText !== undefined && message.text.trim() === "" && message.attachments.some((a) => a.voice);
    if (!heard) return print(message);
    return withVoiceText(message, voiceText, warn, opts).then(print);
  };

/** The whole wait for one transcript, download included; past it the message prints with `""` and a WARN. */
export const VOICE_DEADLINE_MS = 150_000;

/**
 * Channels come from DORI_DISCORD_CHANNEL_ID, DORI_DISCORD_CHANNEL_IDS (comma separated) and DORI_DISCORD_SCOPE=all.
 * DORI_DISCORD_TRANSCRIBE=1 opts in to transcribing owner voice messages with `voiceText` (hooks.transcribe).
 */
export const discordInboundCommand = async (
  stateDir: string,
  gateway: boolean,
  pollMinutes: number,
  voiceText?: VoiceText,
) => {
  const env = process.env;
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", env["DORI_DISCORD_OWNER_ID"]);
  const scope = env["DORI_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all") die("DORI_DISCORD_SCOPE must be all or unset");
  const all = scope === "all";
  const channelIds = ["DORI_DISCORD_CHANNEL_ID", "DORI_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    idList(env[name]).map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("DORI_DISCORD_CHANNEL_ID", env["DORI_DISCORD_CHANNEL_ID"]);
  const token = env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
  const transcribeOn = env["DORI_DISCORD_TRANSCRIBE"]?.trim();
  if (transcribeOn !== undefined && transcribeOn !== "" && transcribeOn !== "1" && transcribeOn !== "0")
    die("DORI_DISCORD_TRANSCRIBE must be 1, 0 or unset");
  if (transcribeOn === "1" && !voiceText) die("DORI_DISCORD_TRANSCRIBE=1 needs hooks.transcribe in config");
  const heardBy = transcribeOn === "1" ? voiceText : undefined;
  const intake = await discordInbound(
    new Discord(fetchHttp, realClock, token),
    (channelId) => fileDiscordInboundStore(stateDir, channelId),
    { ownerId, channelIds: [...new Set(channelIds)], all },
  );
  const watching = all ? "all" : intake.channels().join(",");
  const home = defaultHome();
  // The owner's reply to a post lands in the ledger verbatim; a ledger fault is reported and never holds intake.
  const print = (message: Inbound) => {
    console.log(formatDiscordInbound(message));
    try {
      const head = ledgerReply(home, stateDir, ownerId, message);
      if (head) console.log(`LEDGER ${head}`);
    } catch (e) {
      console.log(`WARN ledger ${message.message}: ${(e as Error).message}`);
    }
  };
  const emit = voiceEmit(print, heardBy, (l) => console.log(l), {
    prefix: env["DORI_DISCORD_VOICE_PREFIX"] ?? DEFAULT_VOICE_PREFIX,
    deadlineMs: VOICE_DEADLINE_MS,
  });
  console.log(
    `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}${heardBy ? " transcribe=on" : ""}`,
  );
  if (!gateway) return await every(pollMinutes, () => intake.poll(emit));
  await untilStopped(discordInboundLive(intake, openDiscordSocket, token, discordClock, emit, (l) => console.log(l)));
};
