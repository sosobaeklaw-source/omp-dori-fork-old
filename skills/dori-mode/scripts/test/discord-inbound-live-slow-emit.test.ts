import { expect, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { withState } from "./fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

test("a live message whose emit is still running holds the next dispatch and its own cursor", async () => {
  const rest = discordRestWorld();
  const cursor = memoryDiscordCursor("100");
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  const intake = await discordInbound(rest.discord, () => cursor.store, options);
  const sockets: FakeGateway[] = [];
  const printed: string[] = [];
  const slow = Promise.withResolvers<void>();
  const live = discordInboundLive(
    intake,
    (url) => {
      const socket = new FakeGateway(url);
      sockets.push(socket);
      return socket;
    },
    "unit-private-token",
    gatewayTimers().clock,
    (message) => {
      if (message.message !== "101") return void printed.push(message.message);
      return slow.promise.then(() => void printed.push("101"));
    },
    () => {},
    queue,
  );
  live.done.catch(() => {});
  const [socket] = sockets;
  if (!socket) throw new Error("gateway did not open");
  socket.hello();
  socket.ready(1);
  await settle();
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("101") });
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ownerMessage("102") });
  await settle();
  expect({ printed, cursor: cursor.store.load() }).toEqual({ printed: [], cursor: "100" });
  slow.resolve();
  await settle();
  await settle();
  expect({ printed, cursor: cursor.store.load() }).toEqual({ printed: ["101", "102"], cursor: "102" });
  live.close();
  queue.close();
  state.done();
});
