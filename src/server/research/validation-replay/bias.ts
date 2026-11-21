import { type FrozenValidationInput } from "../validation-capture";
import { type ScoreboardRow } from "../validation-model";

export function validationBiasTags(
  frozen: FrozenValidationInput,
): NonNullable<ScoreboardRow["biasTags"]> {
  const tags: NonNullable<ScoreboardRow["biasTags"]> = [];
  if (!frozen.evidence.universeComplete)
    tags.push({
      code: "historical-universe-incomplete",
      severity: "high",
      detail:
        "可枚举历史证券池不完整，退市覆盖未知；免费数据研究偏差，不阻断统计晋级",
    });
  if (!frozen.evidence.executionVerified)
    tags.push(
      frozen.input.market === "cn-equity"
        ? {
            code: "historical-execution-unverified",
            severity: "high",
            detail: "历史ST/IPO/队列、成交及现金到账采用未认证情景",
          }
        : {
            code: "historical-venue-filters-and-liquidity-unverified",
            severity: "high",
            detail: "历史平台数量步长、最小金额和流动性容量未认证",
          },
    );
  return tags;
}

export function biasLabels(
  frozen: FrozenValidationInput,
  sleeve: string,
): ScoreboardRow["bias"] {
  return {
    universe: frozen.universe
      ? `${frozen.universe.grade}; historical PIT roster unknown`
      : "Current liquid spot selection, delisted history unknown",
    adjustment:
      frozen.input.market === "cn-equity"
        ? frozen.timingContract === "p5"
          ? "Signals: per-bar causal GBBQ when proved; forward restricted to scale-independent rules; RPS: backward; fills: raw"
          : "Legacy signal price evidence unknown; RPS: backward; fills: raw"
        : "Raw public spot OHLC",
    financial:
      sleeve === "low-zone" ||
      (sleeve === "combined" && frozen.input.market === "cn-equity")
        ? "PIT announcement metadata retained; PE/PB unknown without first-vintage and knownAt evidence"
        : "Not used",
    execution:
      frozen.input.market === "cn-equity"
        ? "Board limit scenario, ST/IPO/queue and payment dates unverified; rule-check-only"
        : "Experimental spot grid/costs, no historical filters/capacity certification; rule-check-only",
  };
}
