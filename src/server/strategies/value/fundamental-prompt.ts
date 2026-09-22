import type { FundamentalDossier } from "./fundamental-dossier";
import type { fundamentalCitationRules } from "./fundamental-report";
type Rules = ReturnType<typeof fundamentalCitationRules>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function replace(value: unknown, mapping: Map<string, string>): unknown {
  if (typeof value === "string") return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replace(item, mapping));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replace(item, mapping)]),
    );
  return value;
}
/** Lossless reference indexing for the model only. Stored evidence and reports keep original IDs. */
export function fundamentalPrompt(dossier: FundamentalDossier, rules: Rules) {
  const data = {
    ...dossier,
    finance: { ...dossier.finance, evidence: undefined },
    price: { id: dossier.price.id },
    context: dossier.context.map((entry) => ({ id: entry.id })),
    evidence: dossier.evidence.map(({ text, ...entry }) => ({
      ...entry,
      payload: JSON.parse(text),
    })),
  };
  const literals = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") literals.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (object(value)) Object.values(value).forEach(collect);
  };
  collect(data);
  collect(rules);
  const evidenceIds = [...new Set(rules.flatMap((rule) => rule.evidenceIds))];
  const methodIds = [...new Set(rules.flatMap((rule) => rule.methodIds))];
  const originals = new Set([...evidenceIds, ...methodIds]),
    encode = new Map<string, string>(),
    decode = new Map<string, string>();
  for (const [prefix, ids] of [
    ["e", evidenceIds],
    ["m", methodIds],
  ] as const) {
    ids.forEach((id, index) => {
      let alias = `@${prefix}${index + 1}`;
      while (literals.has(alias) || decode.has(alias)) alias = `_${alias}`;
      encode.set(id, alias);
      decode.set(alias, id);
    });
  }
  return {
    references: Object.fromEntries(decode),
    data: replace(data, encode),
    rules: replace(rules, encode),
    decodeReply: (value: unknown): unknown => {
      if (!object(value) || !Array.isArray(value.stages)) return value;
      return {
        ...value,
        stages: value.stages.map((stage) => {
          if (!object(stage)) return stage;
          const citations = (items: unknown) =>
            Array.isArray(items)
              ? items.map((id) =>
                  typeof id === "string" && !originals.has(id)
                    ? (decode.get(id) ?? id)
                    : id,
                )
              : items;
          return {
            ...stage,
            citations: citations(stage.citations),
            methodCitations: citations(stage.methodCitations),
          };
        }),
      };
    },
  };
}
