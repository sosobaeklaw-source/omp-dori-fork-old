import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Order, runOrders } from "../tools/open_orders.ts";

const NOW = Date.UTC(2026, 10, 17, 5, 0, 0);
const idAt = (minutes: number): string => String((BigInt(NOW - minutes * 60_000 - 1420070400000) << 22n) + 7n);

type Lane = Order["lanes"][number];
const lane = (key: string, mac: string, status: string, minutesAgo: number): Lane => ({
  key,
  mac,
  status,
  lastActivityAt: NOW - minutesAgo * 60_000,
});

/** This Mac's folder (inbound log, lanes) and a place for the other Mac's open-orders.json. */
function world(ids: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "orders-import-"));
  for (const sub of ["lanes", "briefs", "state"]) mkdirSync(join(dir, sub));
  const inbound = ids.map((id) => `INBOUND discord 1 ${id} from=owner ref=- "지시"`).join("\n");
  writeFileSync(join(dir, "state", "inbound.log"), inbound);
  const local = (key: string, status: string, minutesAgo: number, extra: object = {}) =>
    writeFileSync(
      join(dir, "lanes", `${key}.json`),
      JSON.stringify({ key, status, lastActivityAt: NOW - minutesAgo * 60_000, ...extra }),
    );
  const other = (name: string, orders: Partial<Order>[]) => {
    const file = join(dir, name);
    const full = orders.map((o) => ({ at: 0, body: "미니", macs: ["macmini"], lanes: [], state: "답없음", ...o }));
    writeFileSync(file, JSON.stringify({ at: NOW, notes: [], orders: full }));
    return file;
  };
  const args = [
    "--inbound",
    `macbook=${join(dir, "state", "inbound.log")}`,
    "--lanes",
    `macbook=${join(dir, "lanes")}`,
  ];
  const run = (...more: string[]) => {
    const out: string[] = [];
    runOrders([...args, ...more, "--json"], (line) => out.push(line), NOW);
    return JSON.parse(out[0]!) as { orders: Order[]; notes: string[] };
  };
  return { dir, local, other, run, done: () => rmSync(dir, { recursive: true }) };
}

test("the other Mac's file keeps each order's own macs: an order only the MacBook has stays this Mac's under --mine", () => {
  const [mine, theirs, both] = [idAt(60), idAt(50), idAt(40)];
  const w = world([mine]);
  const json = w.other("open-orders.json", [
    { id: mine, macs: ["macbook"] },
    { id: both, macs: ["macbook", "macmini"] },
    { id: theirs, macs: ["macmini"] },
  ]);
  const seen = (...more: string[]) => w.run(...more, "--mine", "macbook").orders.map((o) => [o.id, o.state, o.macs]);
  expect(seen()).toEqual([[mine, "답없음", ["macbook"]]]);
  expect(seen("--orders-json", `macmini=${json}`)).toEqual([[mine, "답없음", ["macbook"]]]);
  const all = w.run("--orders-json", `macmini=${json}`).orders;
  expect(all.map((o) => [o.id, o.macs])).toEqual([
    [mine, ["macbook"]],
    [theirs, ["macmini"]],
    [both, ["macbook", "macmini"]],
  ]);
  w.done();
});

test("an order in a file that has no macs list is that file's Mac's, as before", () => {
  const id = idAt(30);
  const w = world();
  const json = w.other("old.json", [{ id, macs: undefined as unknown as string[] }]);
  const seen = w.run("--orders-json", `macmini=${json}`).orders;
  expect(seen.map((o) => [o.id, o.macs])).toEqual([[id, ["macmini"]]]);
  w.done();
});

test("a Mac whose own lanes folder is read here keeps its own record: the other Mac's older copy of its lane is dropped", () => {
  const id = idAt(200);
  const w = world([id]);
  w.local("l1", "ready", 50, { orders: [id] });
  const stale = lane("l1", "macbook", "working", 100);
  const json = w.other("open-orders.json", [{ id, macs: ["macbook"], lanes: [stale], state: "일하는중" }]);
  const plain = w.run().orders[0]!;
  expect([plain.state, plain.lanes.map((l) => l.key)]).toEqual(["결과미전달", ["l1"]]);
  const merged = w.run("--orders-json", `macmini=${json}`).orders[0]!;
  expect([merged.state, merged.quietMinutes, merged.lanes.map((l) => [l.key, l.mac, l.status])]).toEqual([
    "결과미전달",
    undefined,
    [["l1", "macbook", "ready"]],
  ]);
  w.done();
});

test("a lane of a Mac with no folder here counts from the file, once per Mac and key, whatever the orders or files that list it", () => {
  const [a, b] = [idAt(300), idAt(290)];
  const w = world();
  const shared = lane("mini-lane", "macmini", "working", 70);
  const one = w.other("a.json", [
    { id: a, lanes: [shared], state: "일하는중" },
    { id: b, lanes: [{ ...shared }], state: "일하는중" },
  ]);
  const two = w.other("b.json", [
    { id: a, lanes: [{ ...shared, lastActivityAt: NOW - 5 * 60_000 }], state: "일하는중" },
  ]);
  const seen = w.run("--orders-json", `macmini=${one}`, "--orders-json", `macmini=${two}`).orders;
  expect(seen.map((o) => [o.id, o.state, o.quietMinutes, o.lanes.map((l) => l.key)])).toEqual([
    [a, "일하는중", 70, ["mini-lane"]],
    [b, "일하는중", 70, ["mini-lane"]],
  ]);
  w.done();
});

test("an orders array holds ids as strings: a JSON number is ignored and named on the notes, the other entries still attach", () => {
  const [byNumber, byString] = [idAt(120), idAt(110)];
  const w = world([byNumber, byString]);
  writeFileSync(
    join(w.dir, "lanes", "numeric.json"),
    `{"key":"numeric","status":"working","lastActivityAt":${NOW - 60_000},"orders":[${byNumber}, 42, null, "${byString}"]}`,
  );
  const { orders, notes } = w.run();
  expect(orders.map((o) => [o.id, o.state, o.lanes.map((l) => l.key)])).toEqual([
    [byNumber, "답없음", []],
    [byString, "일하는중", ["numeric"]],
  ]);
  expect(notes).toEqual([
    `${join(w.dir, "lanes", "numeric.json")} orders: 글자가 아닌 항목 3개는 무시함(번호는 글자여야 함)`,
  ]);
  w.done();
});
