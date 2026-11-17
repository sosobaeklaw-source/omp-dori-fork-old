/**
 * Ontology concepts that widen a recall query. The macmini's ontology (sanjai-agent `outbox/omonyang/ontology/
 * onto.sqlite`) knows that 산재보험법 is 산업재해보상보험법, that 근무기간 and 노출수준 are judged under the same
 * 소음성 난청 guideline, and so on. A request about one of them should also find the case notes written under the
 * others' words. Only concept objects are exported (law and rulings, diseases, judging factors, proof documents,
 * keywords, body parts, occupations): never cases, people, workplaces, accounts or documents, whose names can be
 * clients'. Numeric thresholds (숫자기준: 3년, 85dB) are left out too: "3년" stands in every 공상 or 시효 article and
 * would pull the 난청 guidelines into it.
 *
 * `<home>/ontology-concepts.json` holds `{"made": ISO, "concepts": [{"type", "name", "terms": [...]}]}`; it is made by
 * tools/onto_concepts.ts from four read-only queries and only read here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONCEPT_TYPES = [
  "법령판례",
  "상병",
  "판단요소",
  "입증자료유형",
  "키워드",
  "신체부위",
  "직종",
] as const;

export interface Concept {
  readonly type: string;
  readonly name: string;
  /** Other words for it: aliases, linked concepts, and the guidelines it is cited under. */
  readonly terms: readonly string[];
}

export const conceptsPath = (home: string): string => join(home, "ontology-concepts.json");

/** The exported concepts, or undefined when the file is missing or not the shape above. */
export function loadConcepts(home: string): { made: string; concepts: Concept[] } | undefined {
  const path = conceptsPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { made?: unknown; concepts?: unknown };
    if (typeof raw.made !== "string" || !Array.isArray(raw.concepts)) return undefined;
    const concepts = raw.concepts.filter(
      (c): c is Concept =>
        typeof c?.type === "string" &&
        typeof c?.name === "string" &&
        Array.isArray(c?.terms) &&
        c.terms.every((t: unknown) => typeof t === "string"),
    );
    return { made: raw.made, concepts };
  } catch {
    return undefined;
  }
}

const squeeze = (s: string): string => s.normalize("NFC").replace(/\s+/g, "").toLowerCase();

/** A guideline file's path as words: its file name without the hash tail, the extension and the underscores. */
export const guidelineWords = (path: string): string =>
  (path.split("/").pop() ?? path)
    .replace(/\.(txt|md|pdf|hwpx?)$/i, "")
    .replace(/__[0-9a-f]{6,}$/i, "")
    .replace(/[_]+/g, " ")
    .trim();

export interface Expanded {
  /** The query with every matched concept's other words after it. */
  readonly query: string;
  /** `name→term, term` per matched concept, for the request's count file. */
  readonly used: string[];
}

/**
 * The concepts whose name (spaces ignored, two characters or more) or one of whose terms the text holds, and their
 * other words appended to the query. A concept matched only through a term still adds its name and its other terms.
 */
export function expandQuery(query: string, concepts: readonly Concept[]): Expanded {
  const flat = squeeze(query);
  const used: string[] = [];
  const extra: string[] = [];
  for (const c of concepts) {
    const words = [c.name, ...c.terms];
    const hit = words.find((w) => squeeze(w).length >= 2 && flat.includes(squeeze(w)));
    if (!hit) continue;
    const others = [...new Set(words.filter((w) => w !== hit && !flat.includes(squeeze(w))))];
    if (others.length === 0) continue;
    extra.push(...others);
    used.push(`${hit}→${others.join(", ")}`);
  }
  return { query: extra.length ? `${query}\n${extra.join("\n")}` : query, used };
}
