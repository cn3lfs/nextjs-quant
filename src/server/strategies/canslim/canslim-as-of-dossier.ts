import { createHash } from "node:crypto";
import { z } from "zod";
import { symbolSchema } from "~/lib/domain";
import { researchDateSchema } from "~/lib/research/workflow/research-usage";
import {
  asOfDomains,
  asOfTimestampSchema,
  createAsOfAdapter,
  type AsOfDomain,
} from "~/lib/research/evidence/as-of";
import {
  asOfInputDefinitions,
  readAsOfInput,
  type AsOfInputQuery,
} from "~/lib/research/evidence/as-of-inputs";

export const canslimAsOfRequestSchema = z
  .object({
    symbol: symbolSchema,
    asOf: asOfTimestampSchema,
    capturedBy: asOfTimestampSchema.optional(),
    observationDate: researchDateSchema,
    // Explicit expected periods: absent disclosures produce visible missing rows.
    financialPeriods: z.array(researchDateSchema).min(1).max(100),
    annualPeriods: z.array(researchDateSchema).min(1).max(100),
    institutionPeriods: z.array(researchDateSchema).min(1).max(100),
    universeId: z.string().trim().min(1),
    benchmarkId: z.string().trim().min(1),
  })
  .strict();
export type CanslimAsOfRequest = z.infer<typeof canslimAsOfRequestSchema>;

/** Historical input dossier, deliberately separate from the current-market
 * scorecard/report. B6a provides data contracts only; B6b owns factor methods.
 * No current queries, wall clock, mtime or report-period disclosure inference.
 */
export function buildCanslimAsOfDossier(
  request: CanslimAsOfRequest,
  observations: unknown,
) {
  const parsed = canslimAsOfRequestSchema.parse(request);
  const normalized = {
    ...parsed,
    financialPeriods: [...new Set(parsed.financialPeriods)].sort(),
    annualPeriods: [...new Set(parsed.annualPeriods)].sort(),
    institutionPeriods: [...new Set(parsed.institutionPeriods)].sort(),
  };
  const adapter = createAsOfAdapter(observations, {
    asOf: normalized.asOf,
    capturedBy: normalized.capturedBy,
  });
  const queries: AsOfInputQuery[] = [];
  for (const domain of asOfDomains) {
    for (const field of Object.keys(asOfInputDefinitions[domain])) {
      const periods =
        domain === "finance"
          ? field.startsWith("annual")
            ? normalized.annualPeriods
            : normalized.financialPeriods
          : domain === "institutions"
            ? normalized.institutionPeriods
            : [normalized.observationDate];
      for (const effectiveAt of periods) {
        queries.push({
          domain,
          field,
          effectiveAt,
          entity:
            domain === "rs" && field === "members"
              ? normalized.universeId
              : domain === "benchmarkCalendar"
                ? normalized.benchmarkId
                : normalized.symbol,
        });
      }
    }
  }
  const rows = queries.map((query) => ({
    ...query,
    ...readAsOfInput(adapter, query),
  }));
  const inputs = Object.fromEntries(
    asOfDomains.map((domain) => [
      domain,
      rows.filter((r) => r.domain === domain),
    ]),
  ) as Record<AsOfDomain, typeof rows>;
  const dataGaps = rows
    .filter((r) => r.status === "missing")
    .map((r) => ({
      domain: r.domain,
      entity: r.entity,
      field: r.field,
      effectiveAt: r.effectiveAt,
      code: r.code,
      reason: r.reason,
    }));
  const payload = {
    version: "canslim-as-of-inputs-1",
    request: normalized,
    inputs,
    dataGaps,
  };
  return {
    id:
      "canslim-as-of-" +
      createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    ...payload,
    warnings: [
      "仅历史时点输入资料，不包含因子方法、评分、信号或策略业绩。",
      "首次可知证据须由数据提供者核验并绑定确切值版本；适配器校验契约，不独立认证公告真实性。",
      "采集时间独立保留，可晚于研究时点；需复现当时档案内容时显式设置capturedBy。",
      "本地gpcw报告期和formatVersion不证明披露时间或财务修订；无版本首次可知证据的字段保持missing。",
    ],
  };
}

export async function gatherCanslimAsOfDossier(
  request: CanslimAsOfRequest,
  load: (request: CanslimAsOfRequest, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
) {
  const parsed = canslimAsOfRequestSchema.parse(request);
  signal?.throwIfAborted();
  // A provider must not be able to move the caller's cutoff by mutating its
  // request object while gathering evidence.
  const observations = await load(
    canslimAsOfRequestSchema.parse(parsed),
    signal,
  );
  signal?.throwIfAborted();
  return buildCanslimAsOfDossier(parsed, observations);
}
