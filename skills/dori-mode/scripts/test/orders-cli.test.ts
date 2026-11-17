import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const idAt = (minutes: number): string => String(BigInt(Date.now() - minutes * 60_000 - 1420070400000) << 22n);

test("dori orders reads this Mac's records and the macmini's synced copy; orders close writes the closed log", () => {
  const home = mkdtempSync(join(tmpdir(), "orders-cli-"));
  const state = join(home, "state");
  mkdirSync(join(state, "macmini"), { recursive: true });
  mkdirSync(join(home, "lanes"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ stateDir: state }));
  const [mine, promised, mini] = [idAt(120), idAt(100), idAt(80)];
  writeFileSync(
    join(state, "inbound.log"),
    [mine, promised].map((id) => `INBOUND discord 1 ${id} from=owner ref=- "일"`).join("\n"),
  );
  writeFileSync(join(home, "lanes", "a.json"), JSON.stringify({ key: "a", status: "ready", lastActivityAt: 1 }));
  writeFileSync(join(state, "macmini", "reply.log"), `x to=${promised}\n`);
  const other = { id: mini, at: 0, body: "미니", macs: ["macmini"], lanes: [], state: "답없음" };
  writeFileSync(join(state, "macmini", "open-orders.json"), JSON.stringify({ orders: [other] }));
  const dori = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, DORI_CONFIG: join(home, "config.json") } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const all = JSON.parse(dori("orders", "--json").out) as { orders: { id: string; state: string }[] };
  expect(all.orders.map((o) => [o.id, o.state])).toEqual([
    [mine, "답없음"],
    [promised, "약속만"],
    [mini, "답없음"],
  ]);
  const closed = dori("orders", "close", mine, "--why", "잡담");
  expect([closed.code, closed.out]).toEqual([0, `CLOSED ${mine}\n`]);
  expect(readFileSync(join(state, "orders-closed.log"), "utf8")).toEndWith(`\t${mine}\t잡담\n`);
  const open = dori("orders", "--mine")
    .out.trim()
    .split("\n")
    .filter((line) => !line.startsWith("#"));
  expect(open.map((line) => line.split(" ")[1])).toEqual(["약속만"]);
  expect(dori("orders", "close", mine).err).toContain("--why");
});
