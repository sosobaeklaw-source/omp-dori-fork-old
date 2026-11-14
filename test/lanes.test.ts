import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lessons } from "../skills/dori-mode/scripts/src/lessons.ts";
import { groupId } from "../src/runtime/group.ts";
import { Store } from "../src/store.ts";
import { Refusal } from "../src/refusal.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { group: "w1" })).rejects.toThrow(Refusal);
  });

  test("start ships and records current global and matching repo lessons with their sources", async () => {
    const { d, brief } = setup();
    const previous = process.env["DORI_STATE_DIR"];
    process.env["DORI_STATE_DIR"] = d.store.root;
    try {
      const journal = new Lessons(d.store.root);
      const global = journal.add(
        { lane: "lead", scope: "global", rule: "Review login results", evidence: "report:42" },
        1,
      );
      const repo = journal.add(
        { lane: "old-lane", cwd: d.store.root, rule: "Run the focused test", evidence: "test:7" },
        2,
      );
      journal.add({ lane: "old-lane", cwd: "/other-repo", rule: "Unrelated login rule", evidence: "other:1" }, 3);
      journal.add({ lane: "old-lane", cwd: d.store.root, rule: "Check deployment logs", evidence: "deploy:1" }, 5);
      const retired = journal.add(
        { lane: "old-lane", cwd: d.store.root, rule: "Retired login rule", evidence: "old:1" },
        4,
      );
      journal.mark(retired.id, "harmful");

      const lane = await startLane(d, "lessons-lane", brief, { group: "w1", cwd: d.store.root });
      const shipped = await Bun.file(lane.brief).text();
      expect(shipped).toContain("[pending; lead; source: report:42] Review login results");
      expect(shipped).toContain("[pending; old-lane; source: test:7] Run the focused test");
      expect(shipped).not.toContain("Unrelated login rule");
      expect(shipped).not.toContain("Retired login rule");
      expect(shipped).not.toContain("Check deployment logs");
      expect(shipped.indexOf("Review login results")).toBeGreaterThan(shipped.indexOf("Fix the flaky login test."));
      expect(d.store.lane("lessons-lane")?.lessons).toEqual([global, repo]);
    } finally {
      if (previous === undefined) delete process.env["DORI_STATE_DIR"];
      else process.env["DORI_STATE_DIR"] = previous;
    }
  });

  test("start uses its home state and ignores unrelated configuration settings", async () => {
    const { d, brief } = setup();
    const previousConfig = process.env["DORI_CONFIG"];
    const previousState = process.env["DORI_STATE_DIR"];
    delete process.env["DORI_CONFIG"];
    delete process.env["DORI_STATE_DIR"];
    try {
      const state = join(d.store.root, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ runtime: "invalid" }));
      const lesson = new Lessons(state).add(
        { lane: "lead", scope: "global", rule: "Review login results", evidence: "report:42" },
        1,
      );
      const lane = await startLane(d, "home-lessons", brief, { group: "w1" });
      expect(d.store.lane("home-lessons")?.lessons).toEqual([lesson]);
      expect(await Bun.file(lane.brief).text()).toContain("Review login results");
    } finally {
      if (previousConfig === undefined) delete process.env["DORI_CONFIG"];
      else process.env["DORI_CONFIG"] = previousConfig;
      if (previousState === undefined) delete process.env["DORI_STATE_DIR"];
      else process.env["DORI_STATE_DIR"] = previousState;
    }
  });

  test("start shares the explicitly configured lesson state with skill launch", async () => {
    const { d, brief } = setup();
    const previousConfig = process.env["DORI_CONFIG"];
    const previousState = process.env["DORI_STATE_DIR"];
    const state = join(d.store.root, "shared-state");
    const config = join(d.store.root, "skill-config.json");
    process.env["DORI_CONFIG"] = config;
    delete process.env["DORI_STATE_DIR"];
    try {
      writeFileSync(config, JSON.stringify({ stateDir: state, supervision: { defaults: { tokens: -1 } } }));
      const lesson = new Lessons(state).add(
        { lane: "lead", scope: "global", rule: "Review login results", evidence: "report:42" },
        1,
      );
      await startLane(d, "configured-lessons", brief, { group: "w1" });
      expect(d.store.lane("configured-lessons")?.lessons).toEqual([lesson]);
    } finally {
      if (previousConfig === undefined) delete process.env["DORI_CONFIG"];
      else process.env["DORI_CONFIG"] = previousConfig;
      if (previousState === undefined) delete process.env["DORI_STATE_DIR"];
      else process.env["DORI_STATE_DIR"] = previousState;
    }
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { group: "w1" })).rejects.toThrow(
        `lane key "${key}" is reserved for the ${key} role`,
      );
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toEqual(href("w1:p1"));
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("startLane group fallback", () => {
  const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  };
  const clear = { HERDR_PANE_ID: undefined, HERDR_WORKSPACE_ID: undefined, HC_TERMINAL_ID: undefined };

  test("herdr with no group and no caller session: workspace create, tab create in it, pane run", async () => {
    const { w, d, brief } = setup();
    await withEnv(clear, async () => {
      await startLane(d, "no-group", brief);
    });
    const opening = ["workspace create", "tab create", "pane run"];
    const verbs = w.calls.filter((c) => c.cmd === "herdr").map((c) => c.argv.slice(0, 2).join(" "));
    expect(verbs.filter((v) => opening.includes(v))).toEqual(opening);
    const tab = w.calls.find((c) => c.cmd === "herdr" && c.argv[0] === "tab")!;
    expect(tab.argv).toContain("--workspace");
  });

  test("an hc lane gets this home's group label, never the caller's herdr workspace id", async () => {
    const { w, d: base, brief } = setup({ runtime: "hc" });
    // Keep the foreign workspace text in an unrelated path to catch substring-based false positives.
    const d = { ...base, store: new Store(join(base.store.root, "home-w9")) };
    d.store.setRole("lead", href("w1:p1"));
    await withEnv({ ...clear, HERDR_PANE_ID: "w9:p9", HERDR_WORKSPACE_ID: "w9" }, async () => {
      await startLane(d, "hc-lane", brief);
    });
    const run = w.hc.calls.find((args) => args[0] === "run")!;
    expect(run).toBeDefined();
    const group = run.find((a) => a.startsWith("dori.group="))!;
    expect(group).toMatch(/^dori\.group=[0-9a-f]{8}$/);
    expect(run.filter((a) => a.startsWith("dori.group="))).toEqual([`dori.group=${groupId(d.store.root)}`]);
    expect(run).toContain(`DORI_HOME=${d.store.root}`);
    expect(run).not.toContain("w9");
    expect(run).not.toContain("w9:p9");
    expect(run).not.toContain("--workspace");
  });
});
