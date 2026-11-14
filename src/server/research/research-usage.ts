import { randomUUID } from "node:crypto";
import { usageConfigHash } from "./research-config-hash";
import { readRecordSnapshot, put, sqlite } from "../db";
import { ResearchAttempts, bestEffortAudit } from "./research-governance";
import { settings } from "../infra/settings";
import {
  researchUsageSchema,
  summarizeResearchUsage,
  type ResearchUsage,
  type ResearchRange,
} from "~/lib/research/workflow/research-usage";

type UsageInput = Pick<
  ResearchUsage,
  "kind" | "symbols" | "universeSize" | "range" | "candidateCount"
> & { config: unknown };

/** Observation must never turn successful research into a failed job. */
export function recordResearchUsage(
  input: () => UsageInput,
  attemptId?: string,
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
    const saved = put("research-usage", record.id, record);
    if (attemptId) {
      const linked = bestEffortAudit(() =>
        new ResearchAttempts(sqlite()).update(attemptId, {
          actualRange: value.range,
          symbols: value.symbols,
          usageId: saved.id,
        }),
      );
      if (!linked) markAuditIncomplete(attemptId);
    }
    return saved;
  } catch {
    console.warn("研究使用台账写入失败，本次运行可能未记录");
    if (attemptId) markAuditIncomplete(attemptId);
    return null;
  }
}
function markAuditIncomplete(attemptId: string) {
  bestEffortAudit(() =>
    new ResearchAttempts(sqlite()).update(attemptId, { auditIncomplete: true }),
  );
  bestEffortAudit(() =>
    sqlite()
      .prepare(
        "UPDATE records SET payload=json_set(payload,'$.auditIncomplete',json('true')) WHERE kind IN ('job','research-task') AND json_extract(payload,'$.attemptId')=?",
      )
      .run(attemptId),
  );
}
export function researchUsage(range: ResearchRange) {
  const holdoutStart = settings().holdoutStart;
  return readRecordSnapshot("research-usage", (rows: Iterable<unknown>) => {
    function* validated() {
      for (const row of rows) yield researchUsageSchema.parse(row);
    }
    return summarizeResearchUsage(validated(), range, holdoutStart);
  });
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
