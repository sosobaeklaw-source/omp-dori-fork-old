// The hourly loop's audit pass: open lanes whose session is gone, READY lanes left open, lanes without progress for hours.
import type { Deps } from "./harness.ts";
import { progressOf, waitingSinceOf, waitingTarget } from "./progress.ts";
import { hhmm } from "./fit.ts";
import { refText } from "./refs.ts";
import type { AgentStatus } from "./runtime/types.ts";
import type { LoopRun } from "./store-types.ts";

export const HOUR = 3_600_000;
const STALE_HOURS = 3;
const READY_HOURS = 2;
/** An unclosed READY lane is named once at READY_HOURS, then again only every READY_REPEAT_HOURS: the lead acts on it or not. */
export const READY_REPEAT_HOURS = 6;

const hours = (ms: number): number => Math.floor(ms / HOUR);

/** Which reminder window an age falls in: -1 before `first`, then 0, 1, … every READY_REPEAT_HOURS. */
const window = (age: number, first: number): number =>
  age < first ? -1 : Math.floor((age - first) / (READY_REPEAT_HOURS * HOUR));

/**
 * Whether a line for something that has held since `since` is due: it is past `first`, and no report that reached the
 * lead (`told`) fell in the same window, so the line is named once and then every READY_REPEAT_HOURS.
 */
export const due = (now: number, told: number | undefined, since: number, first: number): boolean => {
  const w = window(now - since, first);
  return w >= 0 && (told === undefined || window(told - since, first) < w);
};

export async function audit(d: Deps, run: LoopRun): Promise<void> {
  const now = d.now();
  // The last report that reached the lead, not the last run: a run whose report did not arrive named nothing.
  const prev = run.told || undefined;
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting" && lane.status !== "ready") continue;
    let st: AgentStatus;
    try {
      st = (await d.runtimes.for(lane.sessionRef).probe(lane.sessionRef)).status;
    } catch (e) {
      run.findings.push(`${lane.sessionRef.runtime}: ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (st === "gone") {
      run.findings.push(`${lane.key} pane ${refText(lane.sessionRef)} is gone`);
    } else if (lane.status === "ready") {
      const since = lane.final?.at ?? lane.lastActivityAt;
      if (due(now, prev, since, READY_HOURS * HOUR))
        run.findings.push(`${lane.key} READY ${hours(now - since)}h ago, not closed: dori harness done ${lane.key}`);
    } else if (now - progressOf(lane) >= STALE_HOURS * HOUR) {
      // Progress, not talk: a lane that keeps reporting without new evidence is as stale as a silent one.
      const age = hours(now - progressOf(lane));
      // A waiting lane's last entry is as often the duty loop's escalation as its own report: name what it waits on,
      // whole, since a cut link or job id names nothing the lead can check.
      run.findings.push(
        lane.status === "waiting"
          ? `${lane.key} waiting, no progress for ${age}h: on ${waitingTarget(lane)} since ${hhmm(waitingSinceOf(lane))}`
          : `${lane.key} working, no progress for ${age}h`,
      );
    }
  }
}
