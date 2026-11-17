import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../src/lane-model.ts";
import { leadPulse, type Pulse } from "../src/lead-pulse.ts";
import { href, World } from "./fake.ts";

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const MACMINI = "/fake/to-macmini.sh";
const idAt = (minutesAgo: number): string => String(BigInt(T0 - minutesAgo * 60_000 - 1420070400000) << 22n);

function setup(opts: { lead?: boolean } = {}) {
  const w = new World();
  w.clock = T0;
  w.addPane("w1:p1", "idle");
  const failCreate = { left: 0 };
  const down = { on: false };
  const inner = w.exec;
  w.exec = async (cmd, argv, o) => {
    if (down.on && cmd === "herdr") throw new Error("spawn herdr ENOENT");
    if (failCreate.left > 0 && cmd === "herdr" && argv[0] === "workspace" && argv[1] === "create") {
      failCreate.left--;
      w.calls.push({ cmd, argv });
      return { code: 1, stdout: "", stderr: "herdr server is down" };
    }
    return inner(cmd, argv, o);
  };
  const d = w.deps();
  if (opts.lead !== false) d.store.setRole("lead", href("w1:p1"));
  const state = homeStateDir(d.store.root);
  mkdirSync(state, { recursive: true });
  const env = { DORI_TO_MACMINI: MACMINI };
  const pulse = () => leadPulse(d, env);
  const file = () => JSON.parse(readFileSync(join(state, "lead-alive.json"), "utf8")) as Pulse;
  const log = () => readFileSync(join(state, "lead-pulse.log"), "utf8");
  const creates = () => w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "workspace" && c.argv[1] === "create");
  const toMacmini = () => w.calls.filter((c) => c.cmd === MACMINI);
  const order = (minutesAgo: number, body = "일") =>
    writeFileSync(
      join(state, "inbound.log"),
      `INBOUND discord 1 ${idAt(minutesAgo)} from=owner ref=- ${JSON.stringify(body)}\n`,
      { flag: "a" },
    );
  return { w, d, state, failCreate, down, pulse, file, log, creates, toMacmini, order };
}

describe("lead pulse", () => {
  test("a lead whose pane is there is alive: the file counts the open orders and starts nothing", async () => {
    const s = setup();
    s.order(120);
    s.order(30);
    writeFileSync(join(s.state, "orders-closed.log"), `x\t${idAt(30)}\t잡담\n`);
    expect(await s.pulse()).toEqual({ at: T0, alive: true, openOrders: 1, oldestMinutes: 120, reviveFailed: false });
    expect(s.file()).toEqual({ at: T0, alive: true, openOrders: 1, oldestMinutes: 120, reviveFailed: false });
    expect(s.w.calls.filter((c) => c.cmd !== "herdr")).toEqual([]);
    expect(s.creates()).toEqual([]);
  });

  test("one dead check is only written down: no start, no line to anyone", async () => {
    const s = setup();
    s.w.panes.delete("w1:p1");
    expect((await s.pulse()).alive).toBe(false);
    expect(s.file().alive).toBe(false);
    expect(s.creates()).toEqual([]);
    expect(s.w.calls.filter((c) => c.cmd !== "herdr")).toEqual([]);
    expect(s.log()).toContain("lead pane gone, first check");
  });

  test("two dead checks in a row start the lead once with the open orders, and send nothing", async () => {
    const s = setup();
    s.order(90, "재해경위서");
    s.w.panes.delete("w1:p1");
    await s.pulse();
    const second = await s.pulse();
    expect(second).toEqual({ at: T0, alive: true, openOrders: 1, oldestMinutes: 90, reviveFailed: false });
    expect(s.creates()).toHaveLength(1);
    const lead = s.d.store.roles().lead!;
    expect(lead.id).toBe("w1:p2");
    const [command] = s.w.panes.get("w1:p2")!.ran;
    expect(command).toContain("lead.md");
    expect(command).toContain("[LEAD-PULSE]");
    expect(command).toContain(`${idAt(90)} 재해경위서`);
    expect(command).not.toContain("\n");
    expect(s.w.calls.filter((c) => c.cmd !== "herdr")).toEqual([]);
    await s.pulse();
    expect(s.creates()).toHaveLength(1);
    expect(s.file().alive).toBe(true);
  });

  test("a start lock held by a live process keeps a second lead from starting", async () => {
    const s = setup();
    s.w.panes.delete("w1:p1");
    writeFileSync(join(s.state, "lead-pulse.lock"), JSON.stringify({ pid: process.pid, at: T0, nonce: "other" }));
    await s.pulse();
    await s.pulse();
    expect(s.creates()).toEqual([]);
    expect(s.file().alive).toBe(false);
    expect(s.log()).toContain(`lead not started: locked by pid ${process.pid}`);
    expect(readFileSync(join(s.state, "lead-pulse.lock"), "utf8")).toContain("other");
  });

  test("a start that fails twice is recorded and told to the macmini once per incident", async () => {
    const s = setup();
    s.failCreate.left = 99;
    s.w.panes.delete("w1:p1");
    await s.pulse();
    const second = await s.pulse();
    expect(second.reviveFailed).toBe(true);
    expect(second.alive).toBe(false);
    expect(s.creates()).toHaveLength(2);
    expect(s.toMacmini()).toHaveLength(1);
    expect(s.toMacmini()[0]!.argv).toEqual(["맥북 리드 창이 사라졌고 두 번 다시 세우지 못했다: herdr server is down"]);
    expect((await s.pulse()).reviveFailed).toBe(true);
    await s.pulse();
    expect(s.creates()).toHaveLength(2);
    expect(s.toMacmini()).toHaveLength(1);
    expect(s.w.calls.filter((c) => c.cmd !== "herdr" && c.cmd !== MACMINI)).toEqual([]);
    s.w.addPane("w1:p1", "idle");
    expect(await s.pulse()).toMatchObject({ alive: true, reviveFailed: false });
    s.w.panes.delete("w1:p1");
    await s.pulse();
    await s.pulse();
    expect(s.creates()).toHaveLength(4);
    expect(s.toMacmini()).toHaveLength(2);
  });

  test("a start that works on the second try tells nobody", async () => {
    const s = setup();
    s.failCreate.left = 1;
    s.w.panes.delete("w1:p1");
    await s.pulse();
    expect(await s.pulse()).toMatchObject({ alive: true, reviveFailed: false });
    expect(s.creates()).toHaveLength(2);
    expect(s.toMacmini()).toEqual([]);
  });

  test("a macmini line that cannot be sent is logged and the pulse is still written", async () => {
    const s = setup();
    s.failCreate.left = 99;
    s.w.reviewer = () => ({ code: 2, stdout: "" });
    s.w.panes.delete("w1:p1");
    await s.pulse();
    await s.pulse();
    expect(s.file().reviveFailed).toBe(true);
    expect(s.log()).toContain("macmini not told (exit 2)");
  });

  test("a macmini sender that is missing is logged and the pulse is still written", async () => {
    const s = setup();
    s.failCreate.left = 99;
    s.w.reviewer = () => {
      throw new Error("spawn /fake/to-macmini.sh ENOENT");
    };
    s.w.panes.delete("w1:p1");
    await s.pulse();
    await s.pulse();
    expect(s.file().reviveFailed).toBe(true);
    expect(s.log()).toContain("macmini not told (spawn /fake/to-macmini.sh ENOENT)");
  });

  test("with no lead registered there is nothing to watch: not alive, nothing started", async () => {
    const s = setup({ lead: false });
    await s.pulse();
    expect(await s.pulse()).toMatchObject({ alive: false, reviveFailed: false });
    expect(s.creates()).toEqual([]);
  });

  test("a runtime that cannot be asked fails the pulse and leaves the file as it was", async () => {
    const s = setup();
    await s.pulse();
    const before = readFileSync(join(s.state, "lead-alive.json"), "utf8");
    s.w.clock += 120_000;
    s.down.on = true;
    await expect(s.pulse()).rejects.toThrow("ENOENT");
    expect(readFileSync(join(s.state, "lead-alive.json"), "utf8")).toBe(before);
    expect(existsSync(join(s.state, "lead-pulse.lock"))).toBe(false);
  });
});
