import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { review } from "../src/gate.ts";
import { shq } from "../src/delivery.ts";
import { agentCommand, defaultAgentCmd, defaultDeps, harnessLaunchEnv } from "../src/harness.ts";
import { installBundle } from "../src/release/install.ts";
import { releasePath } from "../src/release/state.ts";
import { startLane } from "../src/lanes.ts";
import { ompStateDir } from "../src/runtime/omp.ts";
import { ConfigError } from "../src/runtime/select.ts";
import { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";
import { fixture } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

describe("OMP harness launches", () => {
  for (const runtime of ["herdr", "hc"] as const) {
    test(`${runtime}: lead and duty use the Dori role and loop commands stay callable`, async () => {
      const w = new World();
      const d = { ...w.deps({ runtime }), agentCmd: "omp" };
      await captureIo(async () => {
        await up(d, "/w");
        return 0;
      });
      const commands =
        runtime === "herdr"
          ? w.calls.filter((c) => c.cmd === "herdr" && c.argv[1] === "run").map((c) => c.argv[3])
          : w.hc.sent.map((c) => c.text);
      expect(commands).toEqual([
        `omp --dori-role dori --append-system-prompt '${join(d.store.root, "prompts", "lead.md")}'`,
        `omp --dori-role dori --append-system-prompt '${join(d.store.root, "prompts", "duty.md")}'`,
        "dori duty --interval 60",
        "dori loop",
      ]);
    });
  }

  test("implementation lanes keep configured model arguments and select the lane role", async () => {
    const s = setup();
    const d = { ...s.d, agentCmd: "omp --model provider/model" };
    const lane = await startLane(d, "omp-task", s.brief, { group: "w1" });
    expect(s.w.panes.get(lane.paneId)!.ran[0]).toStartWith(
      "omp --model provider/model --dori-role lane '/ulw Read your brief at ",
    );
  });

  test("explicit command and role overrides retain their arguments", () => {
    const d = new World().deps();
    expect(agentCommand({ ...d, agentCmd: "custom-agent --model other" }, "lane")).toBe("custom-agent --model other");
    expect(agentCommand({ ...d, agentCmd: "omp --dori-role=lane --model other" }, "dori")).toBe(
      "omp --dori-role=lane --model other",
    );
    expect(agentCommand({ ...d, agentCmd: "/opt/bin/omp --model other" }, "dori")).toBe(
      "/opt/bin/omp --model other --dori-role dori",
    );
    expect(agentCommand({ ...d, agentCmd: "env MODEL=x '/opt/agent tools/omp'" }, "lane")).toBe(
      "env MODEL=x '/opt/agent tools/omp' --dori-role lane",
    );
    expect(agentCommand({ ...d, agentCmd: "bun /opt/bin/omp --model other" }, "lane")).toBe(
      "bun /opt/bin/omp --model other --dori-role lane",
    );
  });

  test("fresh review preserves the configured command prefix and passes model and prompt as literal arguments", async () => {
    const w = new World();
    const d = { ...w.deps(), agentCmd: "omp --model 'configured model'" };
    w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: "a".repeat(40) }) });
    await review(d, "o/r#7", "selected/model");
    const call = w.calls.find((c) => c.cmd === "env")!;
    const context = Object.entries(harnessLaunchEnv(d)).map(([key, value]) => `${key}=${value}`);
    expect(call.argv.slice(0, context.length)).toEqual(context);
    expect(call.argv.slice(context.length, context.length + 8)).toEqual([
      "sh",
      "-c",
      "unset HERDR_PANE_ID HERDR_WORKSPACE_ID HC_TERMINAL_ID DORI_MANAGED_STARTUP DORI_LANE; omp --model 'configured model' --dori-role lane \"$@\"",
      "dori-review",
      "-p",
      "--no-session",
      "--model",
      "selected/model",
    ]);
    expect(call.argv[context.length + 8]).toContain("o/r#7");
    expect(d.store.receipt("o/r#7", "a".repeat(40))!.model).toBe("selected/model");
  });

  test("default dependencies select OMP, the config's OMP wrapper, and retain an explicit DORI_AGENT_CMD", () => {
    const keys = ["DORI_HOME", "DORI_AGENT_CMD", "DORI_AGENT_ARGV", "DORI_TELEMETRY", "DORI_CMD"];
    const before = keys.map((key) => process.env[key]);
    const home = realpathSync(mkdtempSync(join(tmpdir(), "dori-default-")));
    process.env["DORI_HOME"] = home;
    process.env["DORI_TELEMETRY"] = "0";
    delete process.env["DORI_AGENT_CMD"];
    delete process.env["DORI_AGENT_ARGV"];
    delete process.env["DORI_CMD"];
    try {
      const d = defaultDeps();
      expect(d.agentCmd).toBe("omp");
      expect(agentCommand(d, "dori")).toBe("omp --dori-role dori");
      expect(d.doriCmd).toContain("bun '");
      expect(d.doriCmd).toContain("src/cli.ts");
      // A loop pane started by `up` has DORI_HOME only: the config's wrapper, never the bare binary on PATH.
      const config = (argv: readonly string[]) =>
        writeFileSync(join(home, "config.json"), JSON.stringify({ agentCommand: argv }));
      config(["/side home/bin/omp", "--dori-role", "lane", "--model", "{model}", "{prompt}"]);
      expect(agentCommand(defaultDeps(), "lane")).toBe("'/side home/bin/omp' --dori-role lane");
      config(["~/side/bin/omp", "{prompt}"]);
      expect(defaultDeps().agentCmd).toBe(`${homedir()}/side/bin/omp`);
      config(["custom-agent", "{prompt}"]);
      expect(defaultDeps().agentCmd).toBe("omp");
      writeFileSync(join(d.store.root, ".omp-dori"), "primary\n");
      expect(defaultDeps().agentCmd).toContain(join(d.store.root, "bin/omp"));
      expect(defaultDeps().agentCmd).not.toBe("omp");
      process.env["DORI_AGENT_CMD"] = "custom-agent --model x";
      expect(defaultDeps().agentCmd).toBe("custom-agent --model x");
    } finally {
      keys.forEach((key, i) => {
        if (before[i] === undefined) delete process.env[key];
        else process.env[key] = before[i];
      });
    }
  });

  test("a consumer release re-pins config.json's installed wrapper to its fenced native command", async () => {
    const f = fixture();
    const release = boundRelease(f, "agent");
    const state = await installBundle(f.paths, release.bundle, undefined);
    const sourceRoot = releasePath(f.paths, state.current);
    expect(JSON.parse(readFileSync(f.paths.config, "utf8")).agentCommand[0]).toBe(join(f.paths.dori, "bin/omp"));
    expect(defaultAgentCmd(f.paths.dori, { home: f.paths.home, sourceRoot })).toBe(
      [join(sourceRoot, "scripts/consumer/omp"), "--no-extensions", "-e", join(sourceRoot, "extension")]
        .map(shq)
        .join(" "),
    );
  });

  test("a bare omp in config.json still yields to the marked installation's wrapper", () => {
    const keys = ["DORI_AGENT_CMD", "DORI_AGENT_ARGV"];
    const before = keys.map((key) => process.env[key]);
    for (const key of keys) delete process.env[key];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-bare-omp-")));
    try {
      writeFileSync(join(root, "config.json"), JSON.stringify({ agentCommand: ["omp", "{prompt}"] }));
      expect(defaultAgentCmd(root)).toBe("omp");
      writeFileSync(join(root, ".omp-dori"), "primary\n");
      expect(defaultAgentCmd(root)).toBe(shq(join(root, "bin/omp")));
    } finally {
      keys.forEach((key, i) => {
        if (before[i] === undefined) delete process.env[key];
        else process.env[key] = before[i];
      });
    }
  });
});

test("OMP state directory follows config, environment override and home expansion", () => {
  const root = mkdtempSync(join(tmpdir(), "dori-omp-config-"));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: "~/synthetic-omp-state" }));
  expect(ompStateDir({ DORI_CONFIG: config })).toBe(join(homedir(), "synthetic-omp-state"));
  expect(ompStateDir({ DORI_CONFIG: config, DORI_STATE_DIR: join(root, "override") })).toBe(join(root, "override"));
  expect(ompStateDir({ DORI_CONFIG: join(root, "missing.json") })).toBe(join(homedir(), ".dori", "state"));
});

test("an OMP config that is not an object, or has an unusable stateDir, is a ConfigError naming the file", () => {
  const root = mkdtempSync(join(tmpdir(), "dori-omp-config-"));
  const config = join(root, "config.json");
  for (const [raw, message] of [
    ["null", `${config} must hold a JSON object`],
    ["[1]", `${config} must hold a JSON object`],
    ["{", `${config} is not valid JSON`],
    ['{"stateDir":7}', `${config}: "stateDir" must be a nonempty string`],
    ['{"stateDir":""}', `${config}: "stateDir" must be a nonempty string`],
  ] as const) {
    writeFileSync(config, raw);
    expect(() => ompStateDir({ DORI_CONFIG: config })).toThrow(ConfigError);
    expect(() => ompStateDir({ DORI_CONFIG: config })).toThrow(message);
  }
  for (const raw of ["{}", '{"stateDir":null}']) {
    writeFileSync(config, raw);
    expect(ompStateDir({ DORI_CONFIG: config }, join(root, "state"))).toBe(join(root, "state"));
  }
});
