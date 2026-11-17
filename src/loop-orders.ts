// The hourly loop's order pass: the owner orders `dori orders --mine` still shows open. It names an order nobody answered,
// one whose lane went quiet, and one whose MacBook lane finished but whose result never reached the macmini. It reads
// only: it never closes or edits an order, and never talks to the owner.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { homeStateDir } from "./lane-model.ts";
import { due } from "./loop-audit.ts";
import { ordersMine } from "./orders-mine.ts";
import type { LoopRun } from "./store-types.ts";

const MIN = 60_000;
const UNANSWERED_MIN = 30;
const QUIET_MIN = 60;
const HANDOVER_MIN = 30;

/** Order ids with a `DELIVERED` line in `<stateDir>/to-macmini.log`, which `examples/sobaek/to-macmini.sh --order` writes. */
function handedToMacmini(stateDir: string): Set<string> {
  const file = join(stateDir, "to-macmini.log");
  const log = existsSync(file) ? readFileSync(file, "utf8") : "";
  return new Set([...log.matchAll(/ order=(\d+) DELIVERED /g)].map((m) => m[1]!));
}

export function auditOrders(d: Deps, run: LoopRun): void {
  const now = d.now();
  const told = run.told || undefined;
  const minutes = (since: number): number => Math.floor((now - since) / MIN);
  try {
    const handed = handedToMacmini(homeStateDir(d.store.root));
    for (const o of ordersMine(d.store.root, now).orders) {
      const keys = o.lanes.map((l) => l.key).join(",");
      const busy = o.lanes.filter((l) => l.status !== "ready" && l.status !== "done");
      const lastWork = (lanes: typeof busy): number => Math.max(...lanes.map((l) => l.lastActivityAt));
      if ((o.state === "답없음" || o.state === "약속만") && due(now, told, o.at, UNANSWERED_MIN * MIN)) {
        run.findings.push(`order ${o.id} ${o.state} ${minutes(o.at)}m: ${o.body}`);
      } else if (o.state === "일하는중" && due(now, told, lastWork(busy), QUIET_MIN * MIN)) {
        run.findings.push(`order ${o.id} 일하는중 in ${keys}, quiet ${minutes(lastWork(busy))}m: ${o.body}`);
      } else if (
        o.state === "결과미전달" &&
        !handed.has(o.id) &&
        due(now, told, lastWork(o.lanes), HANDOVER_MIN * MIN)
      ) {
        run.findings.push(
          `order ${o.id} 결과미전달, ${keys} finished ${minutes(lastWork(o.lanes))}m ago, not in to-macmini.log: ${o.body}`,
        );
      }
    }
  } catch (e) {
    run.findings.push(`orders: ${e instanceof Error ? e.message : String(e)}`);
  }
}
