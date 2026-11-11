import { z } from "zod";
import { createHash } from "node:crypto";
import { newsReplaySchema } from "trading-strategies/research/factors/research-news-factors";
import { createAsOfAdapter } from "~/lib/research/evidence/as-of";
import { readAsOfInput } from "~/lib/research/evidence/as-of-inputs";
import type { AsOfDomain } from "trading-strategies/research/contracts/as-of-domain";
import type { buildCanslimAsOfDossier } from "./canslim-as-of-dossier";

export type GrowthFactorEvidenceRow = ReturnType<
  typeof buildCanslimAsOfDossier
>["inputs"][AsOfDomain][number];

class EvidenceValidationError extends Error {}
export function growthFactorEvidenceReader(
  dossier: ReturnType<typeof buildCanslimAsOfDossier>,
  observations: unknown,
) {
  const req = dossier.request;
  const adapter = createAsOfAdapter(observations, {
    asOf: req.asOf,
    capturedBy: req.capturedBy,
  });
  const readRows = Object.values(dossier.inputs).flat();
  return (
    domain: AsOfDomain,
    field: string,
    effectiveAt: string,
  ): { row: GrowthFactorEvidenceRow; error?: string } => {
    const entity =
      domain === "rs" && field === "members" ? req.universeId : req.symbol;
    const query = { domain, field, effectiveAt, entity };
    const row = readRows.find(
      (r) =>
        r.domain === domain &&
        r.field === field &&
        r.effectiveAt === effectiveAt &&
        r.entity === entity,
    ) ?? { ...query, ...readAsOfInput(adapter, query) };
    if (row.status === "missing") return { row };
    const frozenGap = (reason: string) => new EvidenceValidationError(reason);
    try {
      if (
        ((domain === "rs" &&
          ["priceHistory", "crossSection", "sectors"].includes(field)) ||
          (domain === "capital" &&
            [
              "valueMarket",
              "valueThesisObservations",
              "indexValuation",
              "crowdingPanel",
            ].includes(field))) &&
        Date.parse(row.provenance.availableAt) <
          Date.parse(`${effectiveAt}T15:00:00+08:00`)
      ) {
        const reason = "日收盘面板的首次可知时间早于收盘，证据不可信";
        throw frozenGap(reason);
      }
      if (field === "newsReplay") {
        const v = newsReplaySchema.parse(row.value);
        const immutable = (x: z.infer<typeof newsReplaySchema>) =>
          JSON.stringify(x);
        if (Array.isArray(observations))
          for (const raw of observations) {
            const candidate = z
              .object({
                field: z.string(),
                availableAt: z.string(),
                capturedAt: z.string(),
                value: z.unknown(),
              })
              .safeParse(raw);
            if (
              !candidate.success ||
              candidate.data.field !== "newsReplay" ||
              Date.parse(candidate.data.availableAt) > Date.parse(req.asOf) ||
              (req.capturedBy !== undefined &&
                Date.parse(candidate.data.capturedAt) >
                  Date.parse(req.capturedBy))
            )
              continue;
            const other = newsReplaySchema.safeParse(candidate.data.value);
            if (
              other.success &&
              other.data.archiveId === v.archiveId &&
              immutable(other.data) !== immutable(v)
            )
              throw frozenGap(
                "同一archiveId的原文/prompt/模型/映射/首次结果不可替换；新计算须新档案身份",
              );
          }
        for (const [bytes, digest] of [
          [v.rawInput, v.rawInputHash],
          [v.prompt, v.promptHash],
          [v.firstResult, v.firstResultHash],
        ])
          if (createHash("sha256").update(bytes!).digest("hex") !== digest)
            throw frozenGap(
              "原始输入/prompt/首次结果hash不一致，拒绝篡改后的重放",
            );
        if (
          Date.parse(v.firstProcessedAt) >
            Date.parse(row.provenance.availableAt) ||
          Date.parse(v.firstProcessedAt) > Date.parse(row.provenance.capturedAt)
        )
          throw frozenGap("首次结果可知/存档早于模型处理完成");
      }
      if (
        ["eventMarket", "newsSectorPanel"].includes(field) &&
        Date.parse(row.provenance.availableAt) <
          Date.parse(`${effectiveAt}T15:00:00+08:00`)
      )
        throw frozenGap("消息日终价格/资金面板不得早于收盘可知");
      if (
        [
          "valuePolicy",
          "softOverride",
          "indexPolicy",
          "indexEtfMapping",
        ].includes(field)
      ) {
        const frozen = (row.value as { frozenAt: string }).frozenAt;
        if (
          Date.parse(row.provenance.availableAt) > Date.parse(frozen) ||
          Date.parse(row.provenance.capturedAt) > Date.parse(frozen)
        )
          throw frozenGap(
            "冻结参数缺当时档案：首次可知/采集晚于冻结时间；不得事后回填假设",
          );
      }
      if (field === "sentimentPanel") {
        const v = row.value as { origin: string; classifiedAt: string };
        if (
          Date.parse(v.classifiedAt) > Date.parse(req.asOf) ||
          (v.origin !== "rule" &&
            Date.parse(row.provenance.capturedAt) > Date.parse(req.asOf))
        )
          throw frozenGap("情绪分类缺当时处理/采集证据");
      }
      if (field === "valueThesisObservations") {
        const values = Object.values(
          row.value as Record<string, { origin: string; recordedAt: string }>,
        );
        if (
          values.some(
            (v) =>
              v.origin !== "rule" &&
              (Date.parse(v.recordedAt) > Date.parse(req.asOf) ||
                Date.parse(row.provenance.capturedAt) > Date.parse(req.asOf)),
          )
        )
          throw frozenGap("人工/LLM观察无当时归档证据，不充当历史已知判断");
      }
      if (field === "valueTheses") {
        const theses = row.value as { frozenAt: string; recordedAt: string }[];
        if (
          theses.some(
            (t) =>
              Date.parse(row.provenance.availableAt) > Date.parse(t.frozenAt) ||
              Date.parse(row.provenance.capturedAt) > Date.parse(t.frozenAt) ||
              Date.parse(t.recordedAt) > Date.parse(t.frozenAt),
          )
        )
          throw frozenGap("主观假设缺当时冻结档案，不接收回放时生成的历史预测");
      }
      return { row };
    } catch (error) {
      if (error instanceof EvidenceValidationError)
        return { row, error: error.message };
      throw error;
    }
  };
}
