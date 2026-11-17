import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idAt, setup, T0 } from "./lead-pulse-setup.ts";

type Rig = ReturnType<typeof setup>;
const leadPane = (s: Rig) => s.w.panes.get("w1:p1")!;
const mark = (s: Rig) => join(s.state, "lead-starting.json");

describe("lead pulse: a lead whose program died but whose pane stayed", () => {
  test("a shell alone in the pane, seen twice, is one start in that same pane: no new workspace, the registration stays", async () => {
    const s = setup();
    s.order(90, "본문은 싣지 않는다");
    leadPane(s).status = "shell";
    const first = await s.pulse();
    expect(first.alive).toBe(false);
    expect(s.runs("w1:p1")).toEqual([]);
    expect(s.log()).toContain("lead pane holds only a shell, first check");
    const second = await s.pulse();
    expect(second).toEqual({ at: T0, alive: true, openOrders: 1, oldestMinutes: 90, reviveFailed: false });
    const [command, ...more] = s.runs("w1:p1");
    expect(more).toEqual([]);
    expect(command).toContain("lead.md");
    expect(command).toContain(`1 open orders, the 1 oldest: ${idAt(90)} 답없음 90m.`);
    expect(command).toContain("Your pane held only a shell on two checks in a row, so you were started again in it.");
    expect(command).not.toContain("본문은");
    expect(s.creates()).toEqual([]);
    expect(s.d.store.roles().lead?.id).toBe("w1:p1");
    expect(s.w.calls.filter((c) => c.cmd !== "herdr")).toEqual([]);
    expect(s.log()).toContain("lead started in w1:p1 (the same pane, no new workspace)");
  });

  test("a shell seen once starts nothing, and the program being back at the next check cancels it", async () => {
    const s = setup();
    leadPane(s).status = "shell";
    expect((await s.pulse()).alive).toBe(false);
    leadPane(s).status = "idle";
    expect((await s.pulse()).alive).toBe(true);
    leadPane(s).status = "shell";
    expect((await s.pulse()).alive).toBe(false);
    expect(s.runs("w1:p1")).toEqual([]);
    expect(s.creates()).toEqual([]);
    expect(s.log().split("holds only a shell, first check").length - 1).toBe(2);
  });

  test("a lead with its program in front is alive, working or idle, whatever else its pane shows", async () => {
    for (const status of ["idle", "working", "blocked"] as const) {
      const s = setup();
      leadPane(s).status = status;
      await s.pulse();
      expect((await s.pulse()).alive).toBe(true);
      expect(s.runs("w1:p1")).toEqual([]);
    }
  });

  test("a shell in front of a pane the runtime still calls idle is a suspended agent: left alone", async () => {
    const s = setup();
    leadPane(s).foreground = "-bash";
    await s.pulse();
    expect((await s.pulse()).alive).toBe(true);
    expect(s.runs("w1:p1")).toEqual([]);
  });

  test("the runtime's own `unknown` over a shell is dead (a crashed omp leaves its state record), over a program it is alive", async () => {
    const dead = setup();
    leadPane(dead).status = "unknown";
    leadPane(dead).foreground = "-bash";
    await dead.pulse();
    expect((await dead.pulse()).alive).toBe(true);
    expect(dead.runs("w1:p1")).toHaveLength(1);
    const alive = setup();
    leadPane(alive).status = "unknown";
    await alive.pulse();
    expect((await alive.pulse()).alive).toBe(true);
    expect(alive.runs("w1:p1")).toEqual([]);
  });

  test("doubt is not death: a pane the runtime does not call an agent but whose process list cannot be read, or shows a program", async () => {
    const blind = setup();
    leadPane(blind).status = "shell";
    blind.w.processInfoFails = true;
    await blind.pulse();
    expect((await blind.pulse()).alive).toBe(true);
    const program = setup();
    leadPane(program).status = "shell";
    leadPane(program).foreground = "cat";
    await program.pulse();
    expect((await program.pulse()).alive).toBe(true);
    const omp = setup();
    leadPane(omp).status = "shell";
    leadPane(omp).foreground = [
      { name: "omp", argv: ["omp", "--dori-role", "dori"] },
      { name: "bash", argv: ["bash", "check.sh"] },
    ];
    await omp.pulse();
    expect((await omp.pulse()).alive).toBe(true);
    for (const s of [blind, program, omp]) expect([s.runs("w1:p1"), s.creates()]).toEqual([[], []]);
  });

  test("a start into the shell that fails twice is recorded, told to the macmini once, and never falls back to a second lead", async () => {
    const s = setup();
    leadPane(s).status = "shell";
    s.failRun.left = 5;
    await s.pulse();
    const second = await s.pulse();
    expect(second).toMatchObject({ alive: false, reviveFailed: true });
    expect(s.runs("w1:p1")).toEqual([]);
    expect(s.creates()).toEqual([]);
    expect(s.toMacmini()).toHaveLength(1);
    await s.pulse();
    expect(s.toMacmini()).toHaveLength(1);
  });

  test("a start that threw but reached the shell is not typed a second time into the program that runs now", async () => {
    const s = setup();
    leadPane(s).status = "shell";
    s.failRun.left = 1;
    s.failRun.reached = true;
    await s.pulse();
    expect(await s.pulse()).toMatchObject({ alive: true, reviveFailed: false });
    expect(s.runs("w1:p1")).toHaveLength(1);
    expect(s.creates()).toEqual([]);
    expect(s.toMacmini()).toEqual([]);
    expect(s.log()).toContain("lead start 1 of 2 failed: pane run failed");
  });

  test("the stop file holds a shell restart too, and the mark of an unfinished new-workspace start does not hold it", async () => {
    const s = setup();
    leadPane(s).status = "shell";
    s.d.store.setStop(T0, "closed on purpose");
    await s.pulse();
    await s.pulse();
    expect(s.runs("w1:p1")).toEqual([]);
    s.d.store.clearStop();
    writeFileSync(mark(s), `${JSON.stringify({ at: T0 - 60_000 })}\n`);
    await s.pulse();
    expect(s.runs("w1:p1")).toHaveLength(1);
    expect(existsSync(mark(s))).toBe(true);
  });
});

describe("lead pulse: a start that did not finish", () => {
  const gone = async (s: Rig) => {
    s.w.panes.delete("w1:p1");
    await s.pulse();
  };

  test("a mark younger than 10 minutes means a start may still be running or died before registering: no second lead, one line", async () => {
    const s = setup();
    await gone(s);
    writeFileSync(mark(s), `${JSON.stringify({ at: T0 - 9 * 60_000 })}\n`);
    const second = await s.pulse();
    expect(second).toMatchObject({ alive: false, reviveFailed: false });
    expect(s.creates()).toEqual([]);
    expect(s.log()).toContain("did not finish: waiting for it, not starting a second lead");
    expect(existsSync(mark(s))).toBe(true);
    await s.pulse();
    expect(s.creates()).toEqual([]);
  });

  test("a mark of 10 minutes or more is stale: the lead is started again, once, and the mark goes", async () => {
    const s = setup();
    await gone(s);
    writeFileSync(mark(s), `${JSON.stringify({ at: T0 - 10 * 60_000 })}\n`);
    expect((await s.pulse()).alive).toBe(true);
    expect(s.creates()).toHaveLength(1);
    expect(s.log()).toContain("never finished: starting again");
    expect(existsSync(mark(s))).toBe(false);
  });

  test("a start that ends, in success or in failure, leaves no mark, and a mark that cannot be read is no mark", async () => {
    const ok = setup();
    await gone(ok);
    await ok.pulse();
    expect(existsSync(mark(ok))).toBe(false);
    const failing = setup();
    failing.failCreate.left = 9;
    await gone(failing);
    await failing.pulse();
    expect(failing.file().reviveFailed).toBe(true);
    expect(existsSync(mark(failing))).toBe(false);
    const garbled = setup();
    await gone(garbled);
    mkdirSync(join(garbled.state), { recursive: true });
    writeFileSync(mark(garbled), "{half");
    expect((await garbled.pulse()).alive).toBe(true);
    expect(garbled.creates()).toHaveLength(1);
    expect(readFileSync(join(garbled.state, "lead-pulse.log"), "utf8")).not.toContain("waiting for it");
  });
});
