import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { withState } from "./fakes.ts";

const inboundCli = async (
  args: string[],
  environment: Record<string, string> = {},
  prepareOrAround:
    | ((stateDir: string) => void)
    | { prepare?: (dir: string) => void; inspect?: (dir: string) => void } = {},
) => {
  const state = withState();
  try {
    const around = typeof prepareOrAround === "function" ? { prepare: prepareOrAround } : prepareOrAround;
    around.prepare?.(state.dir);
    const config = join(state.dir, "config.json");
    if (!existsSync(config))
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-discord-inbound.ts"),
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "discord",
        ...args,
      ],
      {
        env: {
          HOME: state.dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_HOME: state.dir,
          DORI_STATE_DIR: state.dir,
          DORI_DISCORD_TOKEN: "synthetic-inbound-token",
          DORI_DISCORD_OWNER_ID: "10",
          DORI_DISCORD_CHANNEL_ID: "20",
          ...environment,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const path = join(state.dir, "discord-inbound", "20.json");
    const cursor = existsSync(path) ? fileDiscordInboundStore(state.dir, "20").load() : undefined;
    expect(`${out}\n${err}`).not.toMatch(/synthetic-inbound-token|private|Authorization/);
    around.inspect?.(state.dir);
    return { out, err, code, cursor };
  } finally {
    state.done();
  }
};

test("public Discord intake defaults to three seconds and honors --loop in minutes", async () => {
  for (const [args, milliseconds] of [
    [[], 3_000],
    [["--loop", "0.1"], 6_000],
  ] as const) {
    const { out, err, code, cursor } = await inboundCli([...args]);
    expect({ code, err, cursor }).toEqual({ code: 0, err: "", cursor: "104" });
    expect(out.split("\n").filter((line) => line.startsWith("INBOUND"))).toEqual([
      "INBOUND_READY discord owner=10 channel=20 bot=99",
      'INBOUND discord 20 101 from=owner ref=- "first owner text"',
      'INBOUND discord 20 103 from=owner ref=101 "owner reply"',
    ]);
    const receipt = out.split("\n").find((line) => line.startsWith("DISCORD_INBOUND_QA "));
    expect(JSON.parse(receipt?.slice("DISCORD_INBOUND_QA ".length) ?? "null")).toEqual({
      delays: [milliseconds, milliseconds],
      polls: 2,
      requests: 7,
    });
  }
});

test("an extra channel list naming the same channel is read once and announced once", async () => {
  const { out, err, code } = await inboundCli(["--loop", "0"], { DORI_DISCORD_CHANNEL_IDS: " 20 ,20" });
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.trim().split("\n")[0]).toBe("INBOUND_READY discord owner=10 channel=20 bot=99");
});

test("explicit --loop 0 performs one poll and exits with its cursor persisted", async () => {
  const { out, err, code, cursor } = await inboundCli(["--loop", "0"]);
  expect({ code, err, cursor }).toEqual({ code: 0, err: "", cursor: "102" });
  expect(out.trim().split("\n")).toEqual([
    "INBOUND_READY discord owner=10 channel=20 bot=99",
    'INBOUND discord 20 101 from=owner ref=- "first owner text"',
  ]);
});

test("invalid owner, authentication, permission and content-intent setup never announce readiness", async () => {
  for (const environment of [
    { DORI_DISCORD_OWNER_ID: "1e3" },
    { DORI_DISCORD_TOKEN: "invalid-token" },
    { DORI_TEST_DISCORD_CASE: "permissions" },
    { DORI_TEST_DISCORD_CASE: "intent" },
    { DORI_DISCORD_SCOPE: "everything" },
    { DORI_DISCORD_CHANNEL_IDS: "20,abc" },
  ] as const) {
    const { out, err, code, cursor } = await inboundCli(["--loop", "0"], environment);
    expect({ code, out, cursor }).toEqual({ code: 1, out: "", cursor: undefined });
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).not.toContain("invalid-token");
  }
});

const ledgerSeed = '# 장부\n\n## 2026-11-15 21:00 · video · msg 1571500000000000005 · post -\n원문: "영상 다시"\n';

test("owner replies to logged result posts go into the ledger once, verbatim, under the post's kind", async () => {
  let ledger = "";
  const { out, err, code } = await inboundCli(
    [],
    { DORI_TEST_DISCORD_CASE: "ledger" },
    {
      prepare: (dir) => {
        writeFileSync(join(dir, "반복지적.md"), ledgerSeed);
        writeFileSync(
          join(dir, "discord-sent.log"),
          "1571400000000000001\tcard-lane\tcard\n1571400000000000002\tstatus-lane\t-\n1571400000000000003\tvideo-lane\tvideo\n1571400000000000004\tlegal-lane\tlegal\n",
        );
      },
      inspect: (dir) => {
        ledger = readFileSync(join(dir, "반복지적.md"), "utf8");
      },
    },
  );
  expect({ code, err }).toEqual({ code: 0, err: "" });
  // The card post's replies go in, its "ㄱ" approval too, since nothing reads the words. Out: the reply under a post sent
  // without --kind, one under a post we never logged, one under a legal post (case facts), an empty reply, and a
  // message the ledger already holds.
  expect(out.split("\n").filter((line) => line.startsWith("LEDGER") || line.startsWith("WARN"))).toEqual([
    "LEDGER ## 2026-11-15 21:19 · card · msg 1571500000000000001 · post 1571400000000000001",
    "LEDGER ## 2026-11-15 21:19 · card · msg 1571500000000000006 · post 1571400000000000001",
  ]);
  expect(ledger).toBe(
    `${ledgerSeed}\n## 2026-11-15 21:19 · card · msg 1571500000000000001 · post 1571400000000000001\n원문: "카드 다시 해"\n` +
      `\n## 2026-11-15 21:19 · card · msg 1571500000000000006 · post 1571400000000000001\n원문: "ㄱ"\n`,
  );
});

test("a ledger that cannot be read only warns, and intake still commits its cursor", async () => {
  const { out, err, code, cursor } = await inboundCli(
    [],
    { DORI_TEST_DISCORD_CASE: "ledger" },
    {
      prepare: (dir) => {
        mkdirSync(join(dir, "반복지적.md"));
        writeFileSync(join(dir, "discord-sent.log"), "1571400000000000001\tcard-lane\tcard\n");
      },
    },
  );
  expect({ code, err, cursor }).toEqual({ code: 0, err: "", cursor: "1571500000000000007" });
  expect(out.split("\n").filter((line) => line.startsWith("WARN ledger"))).toEqual([
    expect.stringMatching(/^WARN ledger 1571500000000000001: /),
    expect.stringMatching(/^WARN ledger 1571500000000000006: /),
  ]);
});


test("transcription is opt-in, needs a hook and a non-empty marker, and announces itself", async () => {
  const withHook = {
    prepare: (dir: string) =>
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ stateDir: dir, runtime: "herdr", hooks: { transcribe: ["true", "{file}"] } }),
      ),
  };
  const on = await inboundCli(["--loop", "0"], { DORI_DISCORD_TRANSCRIBE: "1" }, withHook);
  expect(on.out.split("\n")[0]).toBe("INBOUND_READY discord owner=10 channel=20 bot=99 transcribe=on");
  const off = await inboundCli(["--loop", "0"], {}, withHook);
  expect(off.out.split("\n")[0]).toBe("INBOUND_READY discord owner=10 channel=20 bot=99");
  for (const [environment, around, said] of [
    [{ DORI_DISCORD_TRANSCRIBE: "yes" }, withHook, "DORI_DISCORD_TRANSCRIBE must be 1, 0 or unset"],
    [{ DORI_DISCORD_TRANSCRIBE: "1" }, {}, "DORI_DISCORD_TRANSCRIBE=1 needs hooks.transcribe"],
    [{ DORI_DISCORD_TRANSCRIBE: "1", DORI_DISCORD_VOICE_PREFIX: " " }, withHook, "must not be empty"],
  ] as const) {
    const { out, err, code } = await inboundCli(["--loop", "0"], environment, around);
    expect({ code, out, said: err.includes(said) }).toEqual({ code: 1, out: "", said: true });
  }
});
test("--context ends each group with where it was posted and the purposes recorded there", async () => {
  const purposes = (dir: string) =>
    writeFileSync(
      join(dir, "discord-channels.json"),
      JSON.stringify({
        "30": { purpose: "omp-dori development", name: "dev", updatedAt: "2026-11-17T00:00:00.000Z" },
        "20": { purpose: "one task", updatedAt: "2026-11-17T00:00:00.000Z" },
      }),
    );
  const message = 'INBOUND discord 20 101 from=owner ref=- "first owner text"';
  const where = await inboundCli(["--loop", "0", "--context"], { DORI_TEST_DISCORD_CASE: "context" }, purposes);
  expect({ code: where.code, err: where.err, cursor: where.cursor }).toEqual({ code: 0, err: "", cursor: "102" });
  expect(where.out.trim().split("\n").slice(1)).toEqual([
    message,
    `INBOUND_CONTEXT discord 20 101 ${JSON.stringify({
      channel: { id: "30", name: "dev", topic: "editable topic", purpose: "omp-dori development" },
      thread: { id: "20", name: "task thread", purpose: "one task" },
    })}`,
  ]);
  // A failed lookup still delivers the message and commits it; the record says what is known, without the body.
  const denied = await inboundCli(["--loop", "0", "--context"], { DORI_TEST_DISCORD_CASE: "context-denied" }, purposes);
  expect({ code: denied.code, cursor: denied.cursor }).toEqual({ code: 0, cursor: "102" });
  expect(denied.out.trim().split("\n").slice(1)).toEqual([
    message,
    `INBOUND_CONTEXT discord 20 101 ${JSON.stringify({
      channel: { id: "20", purpose: "one task" },
      thread: null,
      error: "channel lookup failed (HTTP 403)",
    })}`,
  ]);
  // Without --context nothing is looked up and the output is unchanged, even where lookups would fail.
  const plain = await inboundCli(["--loop", "0"], { DORI_TEST_DISCORD_CASE: "context-denied" }, purposes);
  expect(plain.out.trim().split("\n").slice(1)).toEqual([message]);
});
