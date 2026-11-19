/**
 * The writing order for one body: the Antigravity seat first, the web seats second.
 *
 * `writer_request agy` and `writer_request send` stay separate commands. This only decides which one runs, from the
 * same files both already share: the agy stop and quota hold, and each web seat's call log, screen-limit rest and
 * disconnection mark. A seat resting or disconnected is not called, and the reason is logged. Nothing here sends a
 * request twice: agy hands back whatever it got, and the web seat moves a request on only when nothing was sent.
 *
 * The web seats get the request only for an agy stop raised before anything went out (stopped, busy, under quota, an
 * account checked before the call). A stop raised after a call (403 on it, a call missing from agy's run log, another
 * account on that call's log) is rethrown as it stands: the request already went out and must not be sent again.
 */
import { existsSync } from "node:fs";
import { type AgyEnv, AgyStop, sendOnAgy, stopPath } from "./writer-agy.ts";
import { readQuotaUntil } from "./agy-own.ts";
import { disconnectedWhy } from "./writer-seat-log.ts";
import { readSeats, restingUntil, type SeatEnv, type SendOpts, sendOnSeat } from "./writer-seat.ts";

export type OrderOpts = SendOpts & { calls: string };

/** Why the agy seat will not be called right now, or undefined when it is the next seat. */
export function agySkipWhy(env: AgyEnv, home: string): string | undefined {
  if (existsSync(stopPath(home))) return `ESCALATE agy-s4 stopped; a person removes ${stopPath(home)}`;
  if (!env.seatAccount) return "no agy account set";
  const mail = env.account();
  if (mail === undefined) return "agy not signed in";
  if (mail !== env.seatAccount) return `agy logged in as ${mail}, not the seat`;
  const until = readQuotaUntil(home);
  if (until > env.now()) return `agy-s4 under quota until ${new Date(until).toISOString()}`;
  return undefined;
}

/**
 * Sends on agy unless that seat is stopped, unsigned, mismatched or under quota, then on the first web seat that is
 * free. Returns which seat answered. A web seat that is disconnected or resting is named in the log and not called.
 */
export async function sendBody(agy: AgyEnv, web: SeatEnv, o: OrderOpts): Promise<{ code: number; seat: string }> {
  const why = agySkipWhy(agy, o.home);
  if (why) {
    agy.log(why.startsWith("ESCALATE") ? why : `SKIP agy-s4: ${why}`);
  } else {
    try {
      const code = await sendOnAgy(agy, o);
      return { code, seat: "agy-s4" };
    } catch (e) {
      if (!(e instanceof AgyStop)) throw e;
      if (e.afterSend) throw e;
      agy.log(e.message.startsWith("ESCALATE") ? e.message : `SKIP agy-s4: ${e.message}`);
    }
  }
  const now = web.now();
  for (const s of readSeats(o.home)) {
    const d = disconnectedWhy(o.home, s.account);
    if (d) web.log(`SKIP ${s.account}: ${d}`);
    const r = restingUntil(o.home, s.account, now);
    if (r) web.log(`SKIP ${s.account}: resting until ${new Date(r).toISOString()}`);
  }
  const sent = await sendOnSeat(web, o);
  return { code: sent.code, seat: sent.seat.account };
}
