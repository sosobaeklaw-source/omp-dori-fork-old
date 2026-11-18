#!/usr/bin/env bun
/**
 * Export the ontology's concepts to DORI_HOME/ontology-concepts.json for writer_request (src/onto-concepts.ts).
 * The database stays where it is (the macmini refreshes it at 04:30); five read-only queries go over ssh, the SQL on
 * stdin so no shell quoting touches it. Run it on the MacBook after the refresh, or anywhere with --host local.
 *
 * A disease (상병) has no link of its own to a guideline in the ontology; it is tied to the guidelines whose name holds
 * it (spaces ignored: 소음성난청 → 소음성 난청 업무처리기준), and through them to the judging factors cited there most
 * (노출수준, 청력손실), so a 난청 request also finds the notes written about those factors.
 */
import { renameSync, writeFileSync } from "node:fs";
import { one, parse } from "../src/cli-args.ts";
import {
  allowedSource,
  CONCEPT_TYPES,
  type Concept,
  conceptsPath,
  GUIDELINE_ORIGINS,
  guidelineSource,
  guidelineWords,
} from "../src/onto-concepts.ts";
import { Refusal } from "../src/refusal.ts";
import { readStudyDirs } from "../src/study-dirs.ts";
import { defaultHome } from "../src/test-home.ts";

const USAGE = `usage:
  onto_concepts [--host macmini|local] [--db PATH]
      -> DORI_HOME/ontology-concepts.json: each concept (${CONCEPT_TYPES.join(", ")}) with its aliases, the concepts
         linked to it and the guidelines (지침문서) it is cited under most, but only when it has at least one fact of
         origin public_reading.jsonl from an allowed study folder without a review flag (sanjai-agent's STUDY_DIRS,
         read at run time; without it nothing is exported). DB defaults to
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
  guidelines: `select name from objects where type = '지침문서'`,
  // The concepts exportable to a writing model: origin public_reading.jsonl and no review flag. The source folder
  // is checked in JS (allowedSource), the sanjai-agent allowlist read at run time (readStudyDirs).
  publicFacts: `select distinct f.object_id as id, f.source as source from facts f
                  left join review_flags r on r.fact_id = f.id
                  where f.origin = 'public_reading.jsonl' and r.fact_id is null`,
  // Guideline documents are not client material: a concept cited in them is exportable too (names and terms only).
  guideFacts: `select distinct f.object_id as id, f.source as source from facts f
                 left join review_flags r on r.fact_id = f.id
                 where f.origin in (${GUIDELINE_ORIGINS.map((o) => `'${o}'`).join(",")}) and r.fact_id is null`,
  factless: `select o.id as id from objects o where o.type = '상병' and not exists (select 1 from facts f where f.object_id = o.id)`,
};

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function query(host: string, db: string, sql: string): Record<string, string | number>[] {
  const uri = `file:${db}?mode=ro`;
  // A remote `~/` is left to the remote shell: `$HOME` stays outside the quotes.
  const remote = db.startsWith("~/") ? `"$HOME"/${quote(`${db.slice(2)}?mode=ro`)}` : quote(`${db}?mode=ro`);
  const cmd =
    host === "local"
      ? ["sqlite3", "-json", uri]
      : ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-S", "none", host, `sqlite3 -json file:${remote}`];
  const r = Bun.spawnSync(cmd, { stdin: Buffer.from(sql), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Refusal(`sqlite3 on ${host} failed: ${r.stderr.toString().trim()}`);
  const out = r.stdout.toString().trim();
  return out ? JSON.parse(out) : [];
}

const squeeze = (s: string): string => s.normalize("NFC").replace(/\s+/g, "");

/** Replace the export in one step, so writer_request never reads half a file. */
function writeConcepts(concepts: Concept[]): string {
  const path = conceptsPath(defaultHome());
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ made: new Date().toISOString(), concepts }, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

try {
  if (process.argv.slice(2).some((x) => x === "--help" || x === "-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const a = parse(process.argv.slice(2));
  if (a.pos.length > 0) throw new Refusal(USAGE);
  const host = one(a, "host") ?? "macmini";
  const db = one(a, "db") ?? "~/sanjai-agent/outbox/omonyang/ontology/onto.sqlite";
  const dbPath = host === "local" && db.startsWith("~/") ? `${process.env["HOME"]}/${db.slice(2)}` : db;
  const objects = query(host, dbPath, QUERIES.objects);
  // Only concepts with an allowed, unflagged public fact are exported; the allowlist is sanjai-agent's own, read at
  // run time. Without it nothing is exported rather than everything.
  const allow = readStudyDirs();
  if (!allow) {
    // An earlier export may hold concepts this filter would drop: leave an empty file, not that one.
    writeConcepts([]);
    throw new Refusal(
      "cannot read sanjai-agent STUDY_DIRS (DORI_STUDY_DIRS, ~/sanjai-agent, ~/.omp-dori/onto-host): exported no concepts",
    );
  }
  const publicIds = new Set<number>();
  for (const r of query(host, dbPath, QUERIES.publicFacts))
    if (allowedSource(String(r["source"]), allow)) publicIds.add(Number(r["id"]));
  for (const r of query(host, dbPath, QUERIES.guideFacts))
    if (guidelineSource(String(r["source"]))) publicIds.add(Number(r["id"]));
  const factless = new Set(query(host, dbPath, QUERIES.factless).map((r) => Number(r["id"])));
  const name = new Map(objects.map((o) => [Number(o["id"]), String(o["name"])]));
  const terms = new Map<number, Set<string>>([...name.keys()].map((id) => [id, new Set<string>()]));
  for (const r of query(host, dbPath, QUERIES.aliases)) terms.get(Number(r["id"]))?.add(String(r["alias"]));
  for (const r of query(host, dbPath, QUERIES.linked)) {
    const [x, y] = [Number(r["a"]), Number(r["b"])];
    terms.get(x)?.add(name.get(y)!);
    terms.get(y)?.add(name.get(x)!);
  }
  const guides = new Map<number, string[]>();
  const citedUnder = new Map<string, number[]>();
  for (const r of query(host, dbPath, QUERIES.guides)) {
    const id = Number(r["id"]);
    const words = guidelineWords(String(r["guide"]));
    const list = guides.get(id) ?? [];
    if (list.length < 2) list.push(words);
    guides.set(id, list);
    citedUnder.set(words, [...(citedUnder.get(words) ?? []), id]);
  }
  const factor = new Set(objects.filter((o) => o["type"] === "판단요소").map((o) => Number(o["id"])));
  const guideNames = query(host, dbPath, QUERIES.guidelines).map((g) => guidelineWords(String(g["name"])));
  for (const o of objects.filter((o) => o["type"] === "상병")) {
    const id = Number(o["id"]);
    const own = squeeze(String(o["name"]));
    if (own.length < 3) continue;
    const titled = guideNames.filter((w) => squeeze(w).includes(own));
    // A disease with no fact of its own that a guideline is named after (소음성난청) is that guideline's public title.
    if (titled.length > 0 && factless.has(id)) publicIds.add(id);
    for (const words of titled) {
      terms.get(id)?.add(words);
      for (const f of citedUnder.get(words) ?? []) if (factor.has(f)) terms.get(id)?.add(name.get(f)!);
    }
  }
  const concepts: Concept[] = objects
    .filter((o) => publicIds.has(Number(o["id"])))
    .map((o) => {
      const id = Number(o["id"]);
      const own = String(o["name"]);
      const all = [...terms.get(id)!, ...(guides.get(id) ?? [])].filter((t) => t && t !== own);
      return { type: String(o["type"]), name: own, terms: [...new Set(all)] };
    })
    .filter((c) => c.terms.length > 0);
  const path = writeConcepts(concepts);
  console.log(
    `WROTE ${path} ${concepts.length} concepts of ${objects.length} (${publicIds.size} with an allowed public fact)`,
  );
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(e.message);
  process.exit(1);
}
