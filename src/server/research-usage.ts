import { createHash, randomUUID } from "node:crypto";
import { list, put } from "./db";
import { settings } from "./settings";
import {
  researchUsageSchema,
  summarizeResearchUsage,
  type ResearchUsage,
  type ResearchRange,
} from "~/lib/research-usage";

export function usageConfigHash(config: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(config)))
    .digest("hex");
}
type UsageInput = Pick<
  ResearchUsage,
  "kind" | "symbols" | "universeSize" | "range" | "candidateCount"
> & { config: unknown };

/** Observation must never turn successful research into a failed job. */
export function recordResearchUsage(
  input: () => UsageInput,
): ResearchUsage | null {
  try {
    const { config, ...value } = input();
    const holdoutStart = settings().holdoutStart;
    const at = Date.now();
    const configHash = usageConfigHash(config);
    const record = researchUsageSchema.parse({
      ...value,
      at,
      configHash,
      holdoutStart,
      touchedHoldout: holdoutStart !== null && value.range.end >= holdoutStart,
      id: `research-usage-${usageConfigHash({ ...value, at, configHash, nonce: randomUUID() })}`,
    });
    return put("research-usage", record.id, record);
  } catch {
    console.warn("研究使用台账写入失败，本次运行可能未记录");
    return null;
  }
}
export function researchUsage(range: ResearchRange) {
  // SQLite LIMIT -1 means unlimited, unlike the shared list default of 200.
  return summarizeResearchUsage(
    list<unknown>("research-usage", -1).map((row) =>
      researchUsageSchema.parse(row),
    ),
    range,
    settings().holdoutStart,
  );
}
export function recordedResearchTrials(
  range: ResearchRange,
  recorded: ResearchUsage | null,
) {
  try {
    if (!recorded)
      return { value: null, reason: "本次台账写入失败，累计值不可得" };
    const summary = researchUsage(range);
    return { value: summary.trialLowerBound, reason: summary.reason };
  } catch {
    console.warn("研究使用台账读取失败，累计值不可得");
    return { value: null, reason: "研究使用台账读取失败" };
  }
}
