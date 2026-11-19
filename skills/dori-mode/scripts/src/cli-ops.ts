/** dori sync, boot, verify-pr and the host loops: watch, freshness, dead-panes, guard, heavy, can-launch. */
import { dirname, join } from "node:path";
import { bootCheck, envSlackCheck } from "./boot.ts";
import { type Command, die, every, slackAuth } from "./cli-context.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { Decisions } from "./decisions.ts";
import { watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { Reports } from "./reports.ts";
import { ordersArgv } from "../../../../src/orders-mine.ts";
import { runOrders } from "../../../../tools/open_orders.ts";
import { runHarness } from "./cli-harness.ts";
import { configPath } from "./config.ts";
import { canLaunch } from "./routing.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { formatVerifyPr, verifyPr } from "./verify-pr.ts";
import { Worklog } from "./worklog.ts";

const sync: Command = async ({ values, deps }) => {
  const r = await syncRegistry(deps, Boolean(values["write"]));
  console.log("key | thread | pane | session | status");
  for (const row of [...r.rows, ...r.unregistered])
    console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
  console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
  console.log(values["write"] ? "WROTE session ids" : "READ_ONLY");
};

const boot: Command = async ({ deps, config }) => {
  const sessionDirs = [
    process.env["PI_SESSION_DIR"],
    process.env["PI_SESSION_FILE"] && dirname(process.env["PI_SESSION_FILE"]),
  ];
  const r = await bootCheck({
    ...deps,
    reports: new Reports(config.stateDir),
    worklog: new Worklog(config.stateDir),
    decisions: new Decisions(config.stateDir),
    // A bad token file is a failed boot line, not an exit: boot is the read-only report a fresh lead depends on.
    slack: envSlackCheck((token) => new Slack(fetchHttp, realClock, slackAuth(token))),
    monitorDirs: sessionDirs.flatMap((dir) => (dir ? [join(dir, "extensions", "terminal")] : [])),
  });
  for (const line of r.lines) console.log(line);
  process.exit(r.exitCode);
};

const verifyPrCommand: Command = async ({ key, positionals, opt, config }) => {
  const repo = key ?? die("verify-pr needs owner/repo and a PR number");
  const expectedIdentity = config.repoIdentities[repo.toLowerCase()],
    cwd = opt("cwd");
  const result = await verifyPr(repo, Number(positionals[1]), run, {
    ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
    loopCount: Number(opt("loop") ?? 20),
    ...(cwd !== undefined ? { cwd } : {}),
  });
  console.log(formatVerifyPr(result));
  process.exit(result.ok ? 0 : 2);
};

const heavy: Command = async ({ rest, config }) => {
  const sep = rest.indexOf("--");
  const label = rest[0];
  const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
  if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
  const load = async () => (await sampleHost(run)).load1;
  const slot = await acquireSlot(
    {
      dir: `${config.stateDir}/heavy`,
      slots: config.heavySlots,
      maxLoad: config.heavyMaxLoad,
      clock: realClock,
      load,
      alive: pidAlive,
      pid: process.pid,
    },
    label ?? "",
  );
  try {
    const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    process.exitCode = await child.exited;
  } finally {
    releaseSlot(slot);
  }
};

export const opsCommands: Readonly<Record<string, Command>> = {
  sync,
  boot,
  "verify-pr": verifyPrCommand,
  watch: async ({ deps }) => {
    console.log("LANE_WATCH_READY");
    for (;;) {
      for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`]))
        console.log(line);
      await Bun.sleep(30_000);
    }
  },
  freshness: async ({ loopMinutes, deps }) => {
    await every(loopMinutes(), async () => {
      for (const a of await freshnessTick(deps, process.env["HOME"] ?? ""))
        console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
    });
  },
  "dead-panes": async ({ loopMinutes, config }) => {
    const seen = new Set<string>();
    const paneState = newDeadPaneState();
    await every(loopMinutes(), async () => {
      for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paneState))
        console.log(line);
    });
  },
  guard: async ({ loopMinutes, config }) => {
    const state = { alerting: false };
    const minutes = loopMinutes();
    console.log("HOST_GUARD_READY");
    await every(minutes, async () => {
      for (const line of guardTick(await sampleHost(run), config.guard, state)) console.log(line);
    });
  },
  heavy,
  "can-launch": async ({ config }) => {
    const v = canLaunch(await sampleHost(run), config.guard);
    console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
    process.exit(v.ok ? 0 : 4);
  },
  /** The lead pulse (src/lead-pulse.ts), through the harness: the scheduled sync calls it. */
  "lead-pulse": async () => {
    process.exit(await runHarness(["lead-pulse"]));
  },
  /** This Mac's records plus the macmini's synced under `<stateDir>/macmini/`; `close` writes `orders-closed.log`. */
  orders: async ({ positionals, opt, values, config }) => {
    const home = dirname(configPath());
    const s = config.stateDir;
    const argv =
      positionals[0] === "close"
        ? ["close", ...positionals.slice(1), "--closed", join(s, "orders-closed.log"), "--why", opt("why") ?? ""]
        : [
            ...ordersArgv(home, s, opt("since") ?? "3d"),
            ...(values["mine"] ? ["--mine", "macbook"] : []),
            ...(values["json"] ? ["--json"] : []),
          ];
    try {
      process.exit(runOrders(argv));
    } catch (e) {
      die((e as Error).message);
    }
  },
};
