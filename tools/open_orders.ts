#!/usr/bin/env bun
/**
 * Open owner orders from both Macs' records, not a lead's memory. Bun built-ins only; both Macs run this same file.
 *   open_orders [list] [--inbound MAC=FILE]... [--inbox-db MAC=FILE]... [--orders-json MAC=FILE]... [--lanes MAC=DIR]...
 *     [--sent-log FILE]... [--reply-log FILE]... [--ready-log FILE]... [--closed FILE] [--owner ID]... [--since 3d]
 *     [--mine MAC] [--json]
 *   open_orders close <id>... --why '<one line>' --closed FILE      (the only writer: `<time>\t<id>\t<why>`)
 * An order is an `INBOUND discord <channel> <id> from=owner` line, or a non-bot row of a read-only discord-inbox.sqlite
 * `incoming` table (by the logs' `INBOUND_READY owner=` ids and `--owner`, when any); one id on both Macs is one order.
 * A lane belongs to an order only through a mark made on purpose: an `orders: ["<id>", …]` array in its record, or a
 * header, the first non-empty line of `briefs/<key>.md` beside its lanes folder, `[보호] 원문(<id>)` (several ids
 * separated by commas; a `:` and text may follow). An id quoted anywhere else, in the record or the brief, attaches
 * nothing, and a `lost` lane (superseded or not) attaches nothing either. States, from records only, never from a
 * reply's words: 닫힘 (a `closes=<id>` in a sent or reply log, a `REPLIED <lane> <id>
 * <reply>` READY reply, the closed log, or 닫힘 in the other Mac's --orders-json), 일하는중 (a lane not ready or done;
 * quiet minutes and Mac shown), 결과미전달 (every lane ready or done), 약속만 (no lane, a `reply=`/`to=` answer
 * without `closes=`), 답없음. A missing or unreadable input is skipped and named on one `# 못 읽음:` line.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

type State = "답없음" | "약속만" | "일하는중" | "결과미전달" | "닫힘";
type Lane = { key: string; mac: string; status: string; lastActivityAt: number };
const BRIEF_MARK = /^\[보호\]\s*원문\(([^)]*)\)/;
export type Order = {
  id: string;
  at: number;
  body: string;
  macs: string[];
  lanes: Lane[];
  state: State;
  closedBy?: string;
  quietMinutes?: number;
};

const ID = /^[1-9]\d{15,21}$/;
const DISCORD_EPOCH = 1420070400000n;
const atOf = (id: string): number => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const short = (text: string): string => [...text.replace(/\s+/g, " ").trim()].slice(0, 40).join("");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const tagged = (raw: string): [string, string] => {
  const at = raw.indexOf("=");
  return at > 0 ? [raw.slice(0, at), raw.slice(at + 1)] : ["-", raw];
};

/** Runs `read` on an input that exists; a missing or unreadable one is named in `notes` and skipped. */
function guarded(path: string, notes: string[], read: () => void): void {
  try {
    if (!existsSync(path)) throw new Error("없음");
    read();
  } catch (e) {
    notes.push(`${path} ${message(e)}`);
  }
}
const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n");

const SINCE = /^(\d+)([mhd])$/;
const sinceMs = (raw: string): number => {
  const m = SINCE.exec(raw);
  if (!m) throw new Error(`--since must look like 30m, 12h or 3d, not ${raw}`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
};

/** The order ids a lane names on purpose: `orders` in its record, and the header of its brief. */
function marked(record: Record<string, unknown>, brief: string): string[] {
  const listed = Array.isArray(record["orders"]) ? record["orders"].map(String) : [];
  const header = brief.split("\n").find((line) => line.trim() !== "");
  const inHeader = BRIEF_MARK.exec(header?.trim() ?? "")?.[1]?.split(",") ?? [];
  return [...new Set([...listed, ...inHeader].map((id) => id.trim()).filter((id) => ID.test(id)))];
}

type Row = { id: unknown; author_id: unknown; body: unknown };
type Values = Record<string, string | boolean | string[] | undefined>;
const list = (v: Values, name: string): string[] => (v[name] as string[] | undefined) ?? [];

export function computeOrders(v: Values, now: number): { orders: Order[]; notes: string[] } {
  const notes: string[] = [];
  const orders = new Map<string, Omit<Order, "state">>();
  const lanes: Lane[] = [];
  const laneOrders = new Map<Lane, string[]>();
  const closedBy = new Map<string, string>();
  const answered = new Set<string>();
  const owners = new Set(list(v, "owner"));
  const add = (id: string, mac: string, body: string) => {
    const o = orders.get(id) ?? { id, at: atOf(id), body: short(body), macs: [], lanes: [] };
    if (!o.macs.includes(mac)) o.macs.push(mac);
    if (!o.body) o.body = short(body);
    orders.set(id, o);
  };
  for (const [mac, path] of list(v, "inbound").map(tagged)) {
    let broken = 0;
    guarded(path, notes, () => {
      for (const line of lines(path)) {
        const ready = /^INBOUND_READY discord owner=(\d+)/.exec(line);
        if (ready) owners.add(ready[1]!);
        if (!line.startsWith("INBOUND ") || !line.includes(" from=owner ")) continue;
        const m = /^INBOUND discord \d+ (\d+) from=owner ref=\S+ (".*")$/.exec(line);
        let body: unknown;
        try {
          body = m ? JSON.parse(m[2]!) : undefined;
        } catch {}
        if (m && ID.test(m[1]!) && typeof body === "string") add(m[1]!, mac, body);
        else broken++;
      }
    });
    if (broken) notes.push(`${path} 깨진 줄 ${broken}개`);
  }
  for (const [mac, path] of list(v, "inbox-db").map(tagged))
    guarded(path, notes, () => {
      const db = new Database(path, { readonly: true });
      try {
        const rows = db.query("SELECT id, author_id, body FROM incoming WHERE author_is_bot = 0").all() as Row[];
        for (const r of rows)
          if (ID.test(String(r.id)) && (owners.size === 0 || owners.has(String(r.author_id))))
            add(String(r.id), mac, String(r.body ?? ""));
      } finally {
        db.close();
      }
    });
  for (const [mac, path] of list(v, "orders-json").map(tagged))
    guarded(path, notes, () => {
      for (const o of (JSON.parse(readFileSync(path, "utf8")) as { orders: Order[] }).orders) {
        add(o.id, mac, o.body);
        for (const lane of o.lanes) {
          lanes.push(lane);
          laneOrders.set(lane, [o.id]);
        }
        if (o.state === "닫힘") closedBy.set(o.id, `${mac} 목록: ${o.closedBy ?? "닫힘"}`);
      }
    });
  for (const path of [...list(v, "sent-log"), ...list(v, "reply-log")])
    guarded(path, notes, () => {
      for (const line of lines(path))
        for (const [, kind, id] of line.matchAll(/\b(to|reply|closes)=(\d+)/g)) {
          answered.add(id!);
          if (kind === "closes" && !closedBy.has(id!)) closedBy.set(id!, `closes= ${line.split(/\s/)[0]}`);
        }
    });
  for (const path of list(v, "ready-log"))
    guarded(path, notes, () => {
      for (const [, key, id, reply] of lines(path)
        .join("\n")
        .matchAll(/\bREPLIED (\S+) (\d+) (\d+)/g))
        if (!closedBy.has(id!)) closedBy.set(id!, `READY 답글 ${reply} (${key})`);
    });
  const closed = v["closed"] as string | undefined;
  if (closed && existsSync(closed))
    for (const [, id, why] of lines(closed).map((line) => line.split("\t")))
      if (id && !closedBy.has(id)) closedBy.set(id, `닫기: ${why ?? ""}`);
  for (const [mac, dir] of list(v, "lanes").map(tagged))
    guarded(dir, notes, () => {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        try {
          const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
          if (typeof r["key"] !== "string" || typeof r["status"] !== "string") continue;
          const brief = join(dirname(dir), "briefs", `${r["key"]}.md`);
          const at = Number(r["lastActivityAt"] ?? r["createdAt"] ?? 0);
          const lane: Lane = { key: r["key"], mac, status: r["status"], lastActivityAt: at };
          lanes.push(lane);
          laneOrders.set(lane, marked(r, existsSync(brief) ? readFileSync(brief, "utf8") : ""));
        } catch (e) {
          notes.push(`${join(dir, name)} ${message(e)}`);
        }
      }
    });
  for (const lane of lanes)
    if (lane.status !== "lost") for (const id of laneOrders.get(lane) ?? []) orders.get(id)?.lanes.push(lane);
  const cutoff = now - sinceMs((v["since"] as string | undefined) ?? "3d");
  const result = [...orders.values()]
    .filter((o) => o.at >= cutoff)
    .sort((a, b) => a.at - b.at)
    .map((o): Order => {
      const by = closedBy.get(o.id);
      if (by) return { ...o, state: "닫힘", closedBy: by };
      const busy = o.lanes.filter((l) => l.status !== "ready" && l.status !== "done");
      if (busy.length) {
        const last = busy.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a));
        return { ...o, state: "일하는중", quietMinutes: Math.floor((now - last.lastActivityAt) / 60_000) };
      }
      if (o.lanes.length) return { ...o, state: "결과미전달" };
      return { ...o, state: answered.has(o.id) ? "약속만" : "답없음" };
    });
  const mine = v["mine"] as string | undefined;
  const kept = mine
    ? result.filter((o) => o.lanes.some((l) => l.mac === mine) || (o.macs.length === 1 && o.macs[0] === mine))
    : result;
  return { orders: kept, notes };
}

const age = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.floor(m / 60)}h${m % 60}m` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
};

/** Runs `list` (the default) or `close`; returns the exit code. */
export function runOrders(
  argv: readonly string[],
  out: (line: string) => void = console.log,
  now = Date.now(),
): number {
  const { values: v, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      inbound: { type: "string", multiple: true },
      "inbox-db": { type: "string", multiple: true },
      "orders-json": { type: "string", multiple: true },
      lanes: { type: "string", multiple: true },
      "sent-log": { type: "string", multiple: true },
      "reply-log": { type: "string", multiple: true },
      "ready-log": { type: "string", multiple: true },
      owner: { type: "string", multiple: true },
      closed: { type: "string" },
      since: { type: "string" },
      mine: { type: "string" },
      json: { type: "boolean" },
      why: { type: "string" },
    },
  });
  if (positionals[0] === "close") {
    const ids = positionals.slice(1);
    const why = v.why?.trim();
    if (!v.closed) throw new Error("close needs --closed FILE");
    if (!ids.length || ids.some((id) => !ID.test(id))) throw new Error("close needs one or more Discord message ids");
    if (!why || why.includes("\n")) throw new Error("close needs --why with one line");
    mkdirSync(dirname(v.closed), { recursive: true });
    for (const id of ids) appendFileSync(v.closed, `${new Date(now).toISOString()}\t${id}\t${why}\n`);
    for (const id of ids) out(`CLOSED ${id}`);
    return 0;
  }
  if (positionals.length && positionals[0] !== "list") throw new Error(`unknown command ${positionals[0]}`);
  const { orders, notes } = computeOrders(v, now);
  if (v.json) {
    out(JSON.stringify({ at: now, notes, orders }, null, 2));
    return 0;
  }
  if (notes.length) out(`# 못 읽음: ${notes.join("; ")}`);
  const open = orders.filter((o) => o.state !== "닫힘");
  if (!open.length) out("열린 지시 없음");
  for (const o of open) {
    const busy = o.state === "일하는중" ? `(조용 ${o.quietMinutes}분 ${o.lanes.map((l) => l.mac).join(",")})` : "";
    out(`${age(now - o.at)} ${o.state}${busy} ${o.id} ${o.body} ${o.lanes.map((l) => l.key).join(",") || "-"}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(runOrders(process.argv.slice(2)));
  } catch (e) {
    console.error(message(e));
    process.exit(2);
  }
}
