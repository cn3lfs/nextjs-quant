import type { Evidence, Report } from "~/lib/domain";
export function sepaSupportPolicy(evidence: Evidence[]) {
  const marketIds: string[] = [],
    financeIds: string[] = [],
    trendIds: string[] = [],
    vcpIds: string[] = [];
  for (const item of evidence) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    if (
      item.envelope?.source === "tdx-local/sh000300" &&
      data.version === "index-context-1" &&
      data.aligned === true &&
      data.aboveMa120 === true
    )
      marketIds.push(item.id);
    const finance = data.sepaFinanceDiagnostic;
    if (
      item.envelope?.source === "hithink-finance-query" &&
      finance?.version === "sepa-finance-diagnostic-2" &&
      ["strict-pass", "tolerant-pass"].includes(finance.gate)
    )
      financeIds.push(item.id);
    const trend = data.sepaTrendDiagnostic;
    const trendKeys = [
      "closeAboveMa20",
      "closeAboveMa60",
      "closeAboveMa120",
      "ma120Rising",
      "movingAverageOrder",
      "within25PercentOf52WeekHigh",
      "relativeStrength85",
    ];
    if (
      item.envelope?.type === "bars" &&
      trend?.applicable === true &&
      trendKeys.every((key) => trend.checks?.[key] === true)
    )
      trendIds.push(item.id);
    const vcp = data.vcpDiagnostic;
    const vcpKeys = [
      "minimumTwoContractions",
      "shrinkingAtLeast30Percent",
      "lastDepthAtMost10Percent",
      "amplitudeAtMost1Point5",
      "finalVolumeDry",
      "duration15To120Bars",
      "consolidationVolumeVersusUptrend",
    ];
    if (
      item.envelope?.type === "bars" &&
      vcp?.applicable === true &&
      vcp.pivot &&
      vcp.ambiguousDates?.length === 0 &&
      vcpKeys.every((key) => vcp.checks?.[key] === true)
    )
      vcpIds.push(item.id);
  }
  return {
    market: {
      ids: marketIds,
      reason:
        "必须引用已对齐且沪深300在MA120之上的服务端指数证据，不能反转弱势检查。",
    },
    fundamentals: {
      ids: financeIds,
      reason: "只有引用服务端基本面严格或宽松通过的财务证据，才能标支持。",
    },
    trend: {
      ids: trendIds,
      reason: "趋势七项检查必须全部为真；RS未知不能标支持。",
    },
    vcp: {
      ids: vcpIds,
      reason: "VCP条件、量能及确认枢纽必须齐全，歧义形态不能标支持。",
    },
    "entry-risk": {
      ids: [] as string[],
      reason:
        "当前未提供经过校验的入场、账户风控及方法冲突解决记录，不能标支持。",
    },
    conclusion: {
      ids: [] as string[],
      reason: "入场风控证据未齐，综合阶段不能标正向支持。",
    },
  };
}
export function sepaSupportedStagesValid(
  stages: Report["stages"],
  evidence: Evidence[],
) {
  const policy = sepaSupportPolicy(evidence);
  return (
    !!stages &&
    stages.every((stage) => {
      if (stage.status === "missing" && !stage.missing.some((s) => s.trim()))
        return false;
      if (stage.status !== "supported" || !(stage.id in policy)) return true;
      return policy[stage.id as keyof typeof policy].ids.some((id) =>
        stage.citations.includes(id),
      );
    })
  );
}
