import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../src/lane-model.ts";
import { leadPulse, type Pulse } from "../src/lead-pulse.ts";
import { href, World } from "./fake.ts";

export const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
export const MACMINI = "/fake/to-macmini.sh";
export const idAt = (minutesAgo: number): string => String(BigInt(T0 - minutesAgo * 60_000 - 1420070400000) << 22n);

export function setup(opts: { lead?: boolean } = {}) {
  const w = new World();
  w.clock = T0;
  w.addPane("w1:p1", "idle");
  const failCreate = { left: 0 };
  const down = { on: false };
  const failRun = { left: 0, reached: false };
  const inner = w.exec;
  w.exec = async (cmd, argv, o) => {
    if (down.on && cmd === "herdr") throw new Error("spawn herdr ENOENT");
    if (failCreate.left > 0 && cmd === "herdr" && argv[0] === "workspace" && argv[1] === "create") {
      failCreate.left--;
      w.calls.push({ cmd, argv });
      return { code: 1, stdout: "", stderr: "herdr server is down" };
    }
    if (failRun.left > 0 && cmd === "herdr" && argv[0] === "pane" && argv[1] === "run") {
      failRun.left--;
      if (!failRun.reached) w.calls.push({ cmd, argv });
      else {
        await inner(cmd, argv, o);
        const typedInto = w.panes.get(String(argv[2]));
        if (typedInto) typedInto.status = "idle";
      }
      return { code: 1, stdout: "", stderr: "pane run failed" };
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
  const runs = (pane: string) => w.panes.get(pane)?.ran ?? [];
  return { w, d, state, failCreate, failRun, down, runs, pulse, file, log, creates, toMacmini, order };
}
