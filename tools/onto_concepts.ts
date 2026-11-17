#!/usr/bin/env bun
/**
 * Export the ontology's concepts to DORI_HOME/ontology-concepts.json for writer_request (src/onto-concepts.ts).
 * The database stays where it is (the macmini refreshes it at 04:30); three read-only queries go over ssh.
 * Run it on the MacBook after the refresh, or anywhere with --host local.
 */
import { renameSync, writeFileSync } from "node:fs";
import { one, parse } from "../src/cli-args.ts";
import { CONCEPT_TYPES, type Concept, conceptsPath, guidelineWords } from "../src/onto-concepts.ts";
import { Refusal } from "../src/refusal.ts";
import { defaultHome } from "../src/test-home.ts";

const USAGE = `usage:
  onto_concepts [--host macmini|local] [--db PATH]
      -> DORI_HOME/ontology-concepts.json: each concept (${CONCEPT_TYPES.join(", ")}) with its aliases, the concepts
         linked to it and the guidelines (지침문서) it is cited under most. DB defaults to
         ~/sanjai-agent/outbox/omonyang/ontology/onto.sqlite on the host.`;

const TYPES = CONCEPT_TYPES.map((t) => `'${t}'`).join(",");
const QUERIES = {
  objects: `select id, type, name from objects where type in (${TYPES})`,
  aliases: `select o.id, a.alias from aliases a join objects o on o.id = a.object_id where o.type in (${TYPES}) and a.alias <> o.name`,
  // Concept to concept, either way; and concept -> 인용 -> 지침문서, counted, so the guideline it is judged under
  // reaches the query (근무기간 -> 소음성 난청 업무처리기준).
  linked: `select s.id as a, d.id as b from links l join objects s on s.id = l.src_id join objects d on d.id = l.dst_id
             where s.type in (${TYPES}) and d.type in (${TYPES})`,
  guides: `select s.id as id, g.name as guide, count(*) as n from links l1 join objects s on s.id = l1.src_id
             join objects c on c.id = l1.dst_id and c.type = '인용' join links l2 on l2.src_id = c.id
             join objects g on g.id = l2.dst_id and g.type = '지침문서'
             where s.type in (${TYPES}) group by s.id, g.name having n >= 3 order by s.id, n desc`,
};

function query(host: string, db: string, sql: string): Record<string, string | number>[] {
  const uri = `file:${db}?mode=ro`;
  const cmd =
    host === "local"
      ? ["sqlite3", "-json", uri, sql]
      : ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-S", "none", host, `sqlite3 -json "${uri}" "${sql.replace(/\s+/g, " ")}"`];
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Refusal(`sqlite3 on ${host} failed: ${r.stderr.toString().trim()}`);
  const out = r.stdout.toString().trim();
  return out ? JSON.parse(out) : [];
}

try {
  const a = parse(process.argv.slice(2));
  if (a.pos.length > 0) throw new Refusal(USAGE);
  const host = one(a, "host") ?? "macmini";
  const db = one(a, "db") ?? "~/sanjai-agent/outbox/omonyang/ontology/onto.sqlite";
  const dbPath = host === "local" && db.startsWith("~/") ? `${process.env["HOME"]}/${db.slice(2)}` : db.replace(/^~\//, "$HOME/");
  const objects = query(host, dbPath, QUERIES.objects);
  const name = new Map(objects.map((o) => [Number(o["id"]), String(o["name"])]));
  const terms = new Map<number, Set<string>>([...name.keys()].map((id) => [id, new Set<string>()]));
  for (const r of query(host, dbPath, QUERIES.aliases)) terms.get(Number(r["id"]))?.add(String(r["alias"]));
  for (const r of query(host, dbPath, QUERIES.linked)) {
    const [x, y] = [Number(r["a"]), Number(r["b"])];
    terms.get(x)?.add(name.get(y)!);
    terms.get(y)?.add(name.get(x)!);
  }
  const guides = new Map<number, string[]>();
  for (const r of query(host, dbPath, QUERIES.guides)) {
    const list = guides.get(Number(r["id"])) ?? [];
    if (list.length < 2) list.push(guidelineWords(String(r["guide"])));
    guides.set(Number(r["id"]), list);
  }
  const concepts: Concept[] = objects
    .map((o) => {
      const id = Number(o["id"]);
      const own = String(o["name"]);
      const all = [...terms.get(id)!, ...(guides.get(id) ?? [])].filter((t) => t && t !== own);
      return { type: String(o["type"]), name: own, terms: [...new Set(all)] };
    })
    .filter((c) => c.terms.length > 0);
  const path = conceptsPath(defaultHome());
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ made: new Date().toISOString(), concepts }, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
  console.log(`WROTE ${path} ${concepts.length} concepts of ${objects.length}`);
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(e.message);
  process.exit(1);
}
