import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Order, runOrders } from "../tools/open_orders.ts";

const NOW = Date.UTC(2026, 10, 17, 5, 0, 0);
const idAt = (minutes: number): string => String((BigInt(NOW - minutes * 60_000 - 1420070400000) << 22n) + 7n);

/** Orders `a`, `b`, `c`… (older first) and lanes with the records and briefs the cases below need. */
function world(count: number) {
  const dir = mkdtempSync(join(tmpdir(), "orders-lanes-"));
  for (const sub of ["lanes", "briefs", "state"]) mkdirSync(join(dir, sub));
  const ids = Array.from({ length: count }, (_, i) => idAt(300 - i * 10));
  writeFileSync(
    join(dir, "state", "inbound.log"),
    ids.map((id) => `INBOUND discord 1 ${id} from=owner ref=- "지시"`).join("\n"),
  );
  const lane = (key: string, status: string, minutesAgo: number, extra: object = {}, brief?: string) => {
    const record = { key, status, createdAt: NOW - 600 * 60_000, lastActivityAt: NOW - minutesAgo * 60_000, ...extra };
    writeFileSync(join(dir, "lanes", `${key}.json`), JSON.stringify(record));
    if (brief !== undefined) writeFileSync(join(dir, "briefs", `${key}.md`), brief);
  };
  const reply = (line: string) => writeFileSync(join(dir, "state", "discord-sent.log"), `${line}\n`);
  const orders = (): Order[] => {
    const lines: string[] = [];
    const args = [
      "--inbound",
      `macbook=${join(dir, "state", "inbound.log")}`,
      "--lanes",
      `macbook=${join(dir, "lanes")}`,
    ];
    const sent = join(dir, "state", "discord-sent.log");
    runOrders([...args, "--sent-log", sent, "--json"], (l) => lines.push(l), NOW);
    return (JSON.parse(lines[0]!) as { orders: Order[] }).orders;
  };
  const view = () => orders().map((o) => [o.state, o.lanes.map((l) => l.key)]);
  return { dir, ids, lane, reply, view, done: () => rmSync(dir, { recursive: true }) };
}

test("a lost lane is not busy: its order falls back to 약속만 or 답없음, and a live lane beside it decides", () => {
  const w = world(5);
  const [lostOnly, promised, superseded, withReady] = w.ids as [string, string, string, string, string];
  w.lane("lost-only", "lost", 600, { orders: [lostOnly] });
  w.lane("lost-promised", "lost", 600, { orders: [promised] });
  w.reply(`7\t-\t-\treply=${promised}`);
  w.lane("lost-old", "lost", 500, { supersededBy: "live-new", orders: [superseded] });
  w.lane("live-new", "working", 20, { orders: [superseded] });
  w.lane("lost-too", "lost", 500, { orders: [withReady] });
  w.lane("ready-one", "ready", 10, { orders: [withReady] });
  expect(w.view()).toEqual([
    ["답없음", []],
    ["약속만", []],
    ["일하는중", ["live-new"]],
    ["결과미전달", ["ready-one"]],
    ["답없음", []],
  ]);
  w.done();
});

test("a lane attaches only through orders in its record or the first line of its brief; quoted ids attach nothing", () => {
  const w = world(7);
  const [byRecord, byHeader, several, colon, quoted, lineTwo, inLog] = w.ids as string[] as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  w.lane("by-record", "working", 5, { orders: [byRecord, "not-an-id", 12] });
  w.lane("by-header", "working", 5, {}, `\n  [보호] 원문(${byHeader})\n`);
  w.lane("by-several", "working", 5, {}, `[보호] 원문(${several}, ${colon}):\n본문`);
  w.lane(
    "quotes",
    "working",
    5,
    { log: [{ text: `see ${quoted}` }], note: quoted },
    `# 제목\n[보호] 원문(${lineTwo})\n배경: ${quoted}\n${inLog}`,
  );
  w.lane("other-form", "working", 5, {}, `회장님 원문(${quoted}): 일`);
  w.lane("no-brief", "working", 5, { sessionRef: { id: quoted } });
  expect(w.view()).toEqual([
    ["일하는중", ["by-record"]],
    ["일하는중", ["by-header"]],
    ["일하는중", ["by-several"]],
    ["일하는중", ["by-several"]],
    ["답없음", []],
    ["답없음", []],
    ["답없음", []],
  ]);
  w.done();
});
