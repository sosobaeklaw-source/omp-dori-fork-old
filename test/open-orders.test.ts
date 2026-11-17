import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Order, runOrders } from "../tools/open_orders.ts";

const NOW = Date.UTC(2026, 10, 17, 5, 0, 0);
const OWNER = "1507329600504598689";
/** A Discord id written `minutes` before NOW. */
const idAt = (minutes: number): string => String((BigInt(NOW - minutes * 60_000 - 1420070400000) << 22n) + 7n);
const o = {
  none: idAt(300),
  promise: idAt(290),
  working: idAt(280),
  undelivered: idAt(270),
  sentClose: idAt(260),
  ready: idAt(250),
  closedLog: idAt(240),
  replyLogClose: idAt(230),
  both: idAt(220),
  plainReplyDone: idAt(210),
  old: idAt(5 * 1440),
};

function world() {
  const dir = mkdtempSync(join(tmpdir(), "orders-"));
  const mb = join(dir, "mb");
  for (const sub of ["lanes", "briefs", "state"]) mkdirSync(join(mb, sub), { recursive: true });
  const inbound = [
    `INBOUND_READY discord owner=${OWNER} channel=1 bot=2`,
    ...Object.entries(o)
      .filter(([k]) => k !== "replyLogClose")
      .map(([k, id]) => `INBOUND discord 1571013138764140544 ${id} from=owner ref=- ${JSON.stringify(`지시 ${k}`)}`),
    "WARN something unrelated",
  ];
  writeFileSync(join(mb, "state", "inbound.log"), `${inbound.join("\n")}\n`);
  const lane = (key: string, status: string, minutesAgo: number, briefText: string) => {
    writeFileSync(
      join(mb, "lanes", `${key}.json`),
      JSON.stringify({ key, status, createdAt: NOW - 600 * 60_000, lastActivityAt: NOW - minutesAgo * 60_000 }),
    );
    writeFileSync(join(mb, "briefs", `${key}.md`), briefText);
  };
  lane("work-lane", "working", 75, `[보호] 원문(${o.working}):\n일`);
  lane("ready-lane", "ready", 30, `\n[보호] 원문(${o.undelivered})\n`);
  lane("done-lane", "done", 20, `[보호] 원문(${o.plainReplyDone})`);
  writeFileSync(
    join(mb, "state", "discord-sent.log"),
    `11\t-\t-\treply=${o.promise}\n12\tx\tall\treply=${o.sentClose}\tcloses=${o.sentClose}\n13\t-\t-\treply=${o.plainReplyDone}\n`,
  );
  writeFileSync(join(mb, "state", "ready-reply.log"), `2026-11-17T04:00:00Z REPLIED some-lane ${o.ready} 99\n`);
  writeFileSync(join(mb, "state", "orders-closed.log"), `2026-11-17T04:00:00Z\t${o.closedLog}\t잡담\n`);
  const mini = join(dir, "mini");
  mkdirSync(mini);
  writeFileSync(join(mini, "reply.log"), `2026-11-17 13:00 to=${o.replyLogClose} closes=${o.replyLogClose}\n`);
  const db = new Database(join(mini, "inbox.sqlite"));
  db.run(
    "CREATE TABLE incoming (id TEXT, channel_id TEXT, guild_id TEXT, author_id TEXT, author_is_bot INTEGER, reply_to TEXT, body TEXT, sent_at TEXT, received_at TEXT, forwarded_at TEXT)",
  );
  const row = db.prepare("INSERT INTO incoming (id, author_id, author_is_bot, body) VALUES (?, ?, ?, ?)");
  row.run(o.both, OWNER, 0, "지시 both");
  row.run(o.replyLogClose, OWNER, 0, "지시 미니만");
  row.run(idAt(100), "999", 0, "남의 글");
  row.run(idAt(90), "888", 1, "봇 글");
  db.close();
  const args = [
    ...["--inbound", `macbook=${join(mb, "state", "inbound.log")}`, "--lanes", `macbook=${join(mb, "lanes")}`],
    ...["--sent-log", join(mb, "state", "discord-sent.log"), "--ready-log", join(mb, "state", "ready-reply.log")],
    ...["--closed", join(mb, "state", "orders-closed.log"), "--reply-log", join(mini, "reply.log")],
    ...["--inbox-db", `macmini=${join(mini, "inbox.sqlite")}`],
  ];
  return { dir, mb, mini, args };
}

function run(argv: string[]): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = runOrders(argv, (line) => lines.push(line), NOW);
  return { code, lines };
}
const asJson = (argv: string[]): { notes: string[]; orders: Order[] } => JSON.parse(run([...argv, "--json"]).lines[0]!);
const stateOf = (orders: Order[]) => Object.fromEntries(orders.map((x) => [x.id, x.state]));

test("each order gets one of five states from the records, and a plain reply= never closes one", () => {
  const w = world();
  const { notes, orders } = asJson(w.args);
  expect(notes).toEqual([]);
  expect(stateOf(orders)).toEqual({
    [o.none]: "답없음",
    [o.promise]: "약속만",
    [o.working]: "일하는중",
    [o.undelivered]: "결과미전달",
    [o.sentClose]: "닫힘",
    [o.ready]: "닫힘",
    [o.closedLog]: "닫힘",
    [o.replyLogClose]: "닫힘",
    [o.both]: "답없음",
    [o.plainReplyDone]: "결과미전달",
  });
  const working = orders.find((x) => x.id === o.working)!;
  expect([working.quietMinutes, working.lanes.map((l) => [l.key, l.mac])]).toEqual([75, [["work-lane", "macbook"]]]);
  const human = run(w.args).lines;
  expect(human[0]).toBe(`5h0m 답없음 ${o.none} 지시 none -`);
  expect(human).toContain(`4h40m 일하는중(조용 75분 macbook) ${o.working} 지시 working work-lane`);
  expect(human.some((l) => l.includes(o.sentClose))).toBe(false);
  rmSync(w.dir, { recursive: true });
});

test("the same message received by both Macs is one order, and --mine keeps only this Mac's", () => {
  const w = world();
  const { orders } = asJson(w.args);
  expect(orders.filter((x) => x.id === o.both).map((x) => x.macs)).toEqual([["macbook", "macmini"]]);
  expect(orders.find((x) => x.id === o.replyLogClose)!.macs).toEqual(["macmini"]);
  expect(orders.map((x) => x.body)).not.toContain("남의 글");
  const mine = asJson([...w.args, "--mine", "macmini"]).orders.map((x) => x.id);
  expect(mine).toEqual([o.replyLogClose]);
  rmSync(w.dir, { recursive: true });
});

test("close appends one line per id and the order is closed after it; bad ids and a missing why are refused", () => {
  const w = world();
  const closed = join(w.mb, "state", "orders-closed.log");
  expect(run(["close", o.none, o.promise, "--why", "결과 필요 없음", "--closed", closed])).toEqual({
    code: 0,
    lines: [`CLOSED ${o.none}`, `CLOSED ${o.promise}`],
  });
  expect(readFileSync(closed, "utf8").split("\n").at(-2)).toBe(
    `${new Date(NOW).toISOString()}\t${o.promise}\t결과 필요 없음`,
  );
  const states = stateOf(asJson(w.args).orders);
  expect([states[o.none], states[o.promise]]).toEqual(["닫힘", "닫힘"]);
  expect(() => run(["close", "abc", "--why", "x", "--closed", closed])).toThrow("Discord message ids");
  expect(() => run(["close", o.none, "--closed", closed])).toThrow("--why");
  rmSync(w.dir, { recursive: true });
});

test("a broken line or a missing sqlite is skipped and named on one line; --since leaves older orders out", () => {
  const w = world();
  const log = join(w.mb, "state", "inbound.log");
  writeFileSync(log, `${readFileSync(log, "utf8")}INBOUND discord 1 ${idAt(5)} from=owner ref=- "cut\n`);
  rmSync(join(w.mini, "inbox.sqlite"));
  const { notes, orders } = asJson(w.args);
  expect(notes).toEqual([`${log} 깨진 줄 1개`, `${join(w.mini, "inbox.sqlite")} 없음`]);
  expect(stateOf(orders)[o.none]).toBe("답없음");
  expect(run(w.args).lines[0]).toBe(`# 못 읽음: ${notes.join("; ")}`);
  expect(orders.some((x) => x.id === o.old)).toBe(false);
  expect(asJson([...w.args, "--since", "6d"]).orders.some((x) => x.id === o.old)).toBe(true);
  rmSync(w.dir, { recursive: true });
});

test("the other Mac's open-orders.json adds its orders, lanes and closings", () => {
  const w = world();
  const extra = idAt(10);
  const json = join(w.dir, "open-orders.json");
  const other: Order[] = [
    { id: o.none, at: 0, body: "지시 none", macs: ["macmini"], lanes: [], state: "닫힘", closedBy: "닫기: x" },
    {
      id: extra,
      at: 0,
      body: "미니 지시",
      macs: ["macmini"],
      lanes: [{ key: "mini-lane", mac: "macmini", status: "working", lastActivityAt: NOW - 61 * 60_000 }],
      state: "일하는중",
    },
  ];
  writeFileSync(json, JSON.stringify({ at: NOW, notes: [], orders: other }));
  const { orders } = asJson([...w.args, "--orders-json", `macmini=${json}`]);
  const states = stateOf(orders);
  expect([states[o.none], states[extra]]).toEqual(["닫힘", "일하는중"]);
  expect(orders.find((x) => x.id === extra)!.quietMinutes).toBe(61);
  rmSync(w.dir, { recursive: true });
});
