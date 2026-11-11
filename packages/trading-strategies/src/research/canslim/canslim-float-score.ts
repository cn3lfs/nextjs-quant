export type CanslimFloatEvents = {
  symbol: string;
  unlockWithinThreeMonths: boolean;
  activeBuybackPlan: boolean;
  asOf: string;
  evidenceIds: string[];
} | null;
export function scoreCanslimFloat(
  symbol: string,
  yuan: number | null,
  asOf: string,
  events: CanslimFloatEvents,
) {
  const cap = yuan === null ? null : yuan / 1e8;
  const basePoints =
    cap === null
      ? null
      : cap >= 100 && cap <= 300
        ? 5
        : cap >= 50 && cap <= 500
          ? 4
          : cap >= 30 && cap <= 1000
            ? 2
            : 0;
  const validEvents =
    events !== null &&
    events.symbol === symbol &&
    events.asOf === asOf &&
    typeof events.unlockWithinThreeMonths === "boolean" &&
    typeof events.activeBuybackPlan === "boolean" &&
    events.evidenceIds.length > 0 &&
    events.evidenceIds.every(
      (id) => typeof id === "string" && id.trim().length > 0,
    );
  const computed = basePoints !== null && validEvents;
  return {
    id: "S2",
    maxPoints: 5,
    version: "canslim-float-1",
    status: computed ? "computed" : "missing",
    points: computed
      ? Math.max(
          0,
          Math.min(
            5,
            basePoints! -
              (events!.unlockWithinThreeMonths ? 1 : 0) +
              (events!.activeBuybackPlan ? 1 : 0),
          ),
        )
      : 0,
    asOf,
    floatMarketCapYuan: yuan,
    floatMarketCapYi: cap,
    basePoints,
    eventEvidenceIds: validEvents ? events!.evidenceIds : [],
    warnings: [
      "只解析同基准日精确流通市值字段（元转亿元），不以总市值、股本或其他日期替代。",
      "重叠边界取较高基础档：100/300亿5分、50/500亿4分、30/1000亿2分。解禁-1与有效回购计划+1合并后限制0–5分。",
      "缺少同日未来三个月解禁与有效回购计划证据时仅展示基础档，不输出完整S2评分。回购计划不代表已实施或流通盘已减少。",
    ],
  };
}
