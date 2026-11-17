/** The Discord Gateway plumbing shared by `dori presence discord` and `dori inbound discord --gateway`. */
import { die, every } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import type { GatewayClock, GatewaySocket } from "./messenger/discord-gateway.ts";
import { discordInbound, formatDiscordInbound } from "./messenger/discord-inbound.ts";
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

/** A voice message's text: the hook's local transcript, prefixed so a reader knows it is machine-heard. */
export type VoiceText = (url: string) => Promise<string>;
export const VOICE_PREFIX = "(음성 받아쓰기, 실행 전 회장님께 되물을 것) ";

/** Fills an empty-text voice message with its transcript; a failure leaves the message as it was and says why. */
export const withVoiceText = async (
  message: Parameters<typeof formatDiscordInbound>[0],
  voiceText: VoiceText | undefined,
  warn: (line: string) => void,
): Promise<Parameters<typeof formatDiscordInbound>[0]> => {
  const voice = message.attachments.find((a) => a.voice);
  if (!voiceText || !voice || message.text.trim() !== "") return message;
  try {
    return { ...message, text: VOICE_PREFIX + (await voiceText(voice.url)) };
  } catch (e) {
    warn(`WARN transcribe ${message.message}: ${(e as Error).message}`.slice(0, 300));
    return message;
  }
};

/** Channels come from DORI_DISCORD_CHANNEL_ID, DORI_DISCORD_CHANNEL_IDS (comma separated) and DORI_DISCORD_SCOPE=all. */
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
  const intake = await discordInbound(
    new Discord(fetchHttp, realClock, token),
    (channelId) => fileDiscordInboundStore(stateDir, channelId),
    { ownerId, channelIds: [...new Set(channelIds)], all },
  );
  const watching = all ? "all" : intake.channels().join(",");
  const home = defaultHome();
  // The owner's reply to a post lands in the ledger verbatim; a ledger fault is reported and never holds intake.
  const print = (message: Parameters<typeof formatDiscordInbound>[0]) => {
    console.log(formatDiscordInbound(message));
    try {
      const head = ledgerReply(home, stateDir, ownerId, message);
      if (head) console.log(`LEDGER ${head}`);
    } catch (e) {
      console.log(`WARN ledger ${message.message}: ${(e as Error).message}`);
    }
  };
  // A voice message returns a promise: the intake waits for its transcript before the next message and before
  // saving its cursor, so arrival order holds and a crash mid-transcription replays it. Everything else prints at once.
  const emit = (message: Parameters<typeof formatDiscordInbound>[0]): void | Promise<void> => {
    const heard = voiceText !== undefined && message.text.trim() === "" && message.attachments.some((a) => a.voice);
    if (!heard) return print(message);
    return withVoiceText(message, voiceText, (l) => console.log(l)).then(print);
  };
  console.log(
    `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}`,
  );
  if (!gateway) return await every(pollMinutes, () => intake.poll(emit));
  await untilStopped(discordInboundLive(intake, openDiscordSocket, token, discordClock, emit, (l) => console.log(l)));
};
