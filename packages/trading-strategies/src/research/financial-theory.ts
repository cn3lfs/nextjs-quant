import {
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";

export const financialTheoryVersion = "tdx-financial-theory-v2";
export const financialTheoryFieldIds = [
  8, 21, 27, 31, 32, 40, 41, 52, 54, 55, 56, 64, 74, 75, 95, 107, 120, 207,
] as const;
export type FinancialTheoryFact = {
  value: number | null;
  unit: string;
  source: string;
  asOf: string;
  availableFrom?: string;
  reason?: string | null;
};
export type FinancialTheoryEvidence = {
  reportDate: string;
  code: string;
  value: number | null;
  unit: string;
  sourceSha256: string;
  reason: string | null;
};
export type FinancialTheoryCheck = {
  id: string;
  label: string;
  formula: string;
  matched: boolean | null;
  value: number | null;
  reason: string | null;
  inputs: FinancialTheoryEvidence[];
};
export type FinancialTheoryContext = {
  asOf: string;
  strict: boolean;
  /** Certified ordinary-share issuance for the selected fiscal year; capital balance is insufficient. */
  ordinarySharesIssued?: FinancialTheoryFact;
  marketCapitalization?: FinancialTheoryFact;
  interestBearingDebt?: FinancialTheoryFact;
};

export type SpecialProductionAssetsQualification = {
  /** Exactly one finite FN31 and one finite FN32 authenticated value. */
  complete: boolean;
  /** Both values are explicitly certified zero, allowing the normal FN27 model. */
  certifiedZero: boolean;
  reason: string | null;
};

/** One shared FN31/FN32 rule for the formula and replay completeness. A source
 * zero, null, duplicate, extra code, or non-finite value is not a certified
 * business zero; a known positive asset requires a separate capital basis. */
export function specialProductionAssetsQualification(
  assets: readonly Pick<FinancialTheoryEvidence, "code" | "value">[],
): SpecialProductionAssetsQualification {
  if (assets.length !== 2)
    return {
      complete: false,
      certifiedZero: false,
      reason: `特殊生产资产需恰好FN31/FN32两项，当前${assets.length}项`,
    };
  const byCode = new Map<string, number>();
  for (const asset of assets) {
    if (asset.code !== "FN31" && asset.code !== "FN32")
      return {
        complete: false,
        certifiedZero: false,
        reason: `特殊生产资产包含未知代码${asset.code}`,
      };
    if (byCode.has(asset.code))
      return {
        complete: false,
        certifiedZero: false,
        reason: `特殊生产资产${asset.code}重复`,
      };
    if (asset.value === null)
      return {
        complete: false,
        certifiedZero: false,
        reason: `特殊生产资产${asset.code}未知或未认证`,
      };
    if (!Number.isFinite(asset.value))
      return {
        complete: false,
        certifiedZero: false,
        reason: `特殊生产资产${asset.code}非有限数`,
      };
    if (asset.value < 0)
      return {
        complete: false,
        certifiedZero: false,
        reason: `特殊生产资产${asset.code}为负数，不能认证为零`,
      };
    byCode.set(asset.code, asset.value);
  }
  if (!byCode.has("FN31") || !byCode.has("FN32"))
    return {
      complete: false,
      certifiedZero: false,
      reason: "特殊生产资产缺少FN31或FN32",
    };
  if ([...byCode.values()].some((value) => value > 0))
    return {
      complete: true,
      certifiedZero: false,
      reason:
        "存在已知正特殊生产资产，FN27不足以代表全部生产资本；特殊资产口径待核验",
    };
  return { complete: true, certifiedZero: true, reason: null };
}

function annualReports(
  reports: readonly FinancialReportSnapshot[],
  context: FinancialTheoryContext,
) {
  return reports
    .filter(
      (r) =>
        r.reportDate.endsWith("-12-31") &&
        r.reportDate <= context.asOf &&
        (!r.announcementDate || r.announcementDate <= context.asOf) &&
        (!context.strict ||
          (!!r.announcementDate &&
            r.announcementDate > r.reportDate &&
            !!r.availableFrom &&
            r.availableFrom <= context.asOf)),
    )
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
}
function evidence(
  report: FinancialReportSnapshot | undefined,
  code: number,
): FinancialTheoryEvidence {
  const cell = report?.fields.find((f) => f.code === `FN${code}`);
  return {
    reportDate: report?.reportDate ?? "",
    code: `FN${code}`,
    value: sourceFinancialValue(report, code),
    unit: cell?.unit ?? "元",
    sourceSha256: report?.sourceSha256 ?? "",
    reason:
      cell?.reason ??
      (!report ? "所需完整年度缺失" : !cell ? "所需字段缺失" : null),
  };
}
const ratio = (a: number, b: number) => (b > 0 ? a / b : NaN);
function check(
  id: string,
  label: string,
  formula: string,
  inputs: FinancialTheoryEvidence[],
  calculate: (...values: number[]) => number,
  pass: (value: number) => boolean = (v) => v > 0,
): FinancialTheoryCheck {
  const raw = inputs.some((i) => i.value === null)
    ? null
    : calculate(...inputs.map((i) => i.value!));
  const value = raw !== null && Number.isFinite(raw) ? raw : null;
  return {
    id,
    label,
    formula,
    inputs,
    value,
    matched: value === null ? null : pass(value),
    reason:
      value === null
        ? (inputs.find((i) => i.value === null)?.reason ??
          "分母非正或计算结果无效")
        : null,
  };
}

/** Net income uses consolidated FN95: explicitly a local accounting proxy, not original pre-extraordinary NI. */
export function evaluateFinancialTheory(
  reports: readonly FinancialReportSnapshot[],
  context: FinancialTheoryContext,
) {
  const annual = annualReports(reports, context),
    current = annual[0];
  const year = current ? +current.reportDate.slice(0, 4) : 0;
  const unique = (date: string) => {
    const matches = annual.filter((r) => r.reportDate === date);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const now = current ? unique(current.reportDate) : undefined,
    prior = unique(`${year - 1}-12-31`),
    before = unique(`${year - 2}-12-31`);
  const n = (code: number) => evidence(now, code),
    p = (code: number) => evidence(prior, code),
    b = (code: number) => evidence(before, code);
  const checks = [
    check(
      "profitability",
      "正资产收益率",
      "FN95 / 上年末FN40 > 0",
      [n(95), p(40)],
      ratio,
    ),
    check(
      "cash-flow",
      "正经营现金流",
      "FN107 / 上年末FN40 > 0",
      [n(107), p(40)],
      ratio,
    ),
    check(
      "roa-improvement",
      "资产收益率改善",
      "本年NI/期初资产 − 上年NI/期初资产 > 0",
      [n(95), p(40), p(95), b(40)],
      (ni, assets, oldNi, oldAssets) =>
        ratio(ni, assets) - ratio(oldNi, oldAssets),
    ),
    check(
      "accrual",
      "现金流质量",
      "(FN107 − FN95) / 期初资产 > 0",
      [n(107), n(95), p(40)],
      (cash, profit, assets) => ratio(cash - profit, assets),
    ),
    check(
      "leverage",
      "长期债务杠杆改善",
      "上年(长期借款+应付债券)/平均资产 − 本年同口径 > 0",
      [p(55), p(56), p(40), b(40), n(55), n(56), n(40)],
      (oldLoan, oldBond, oldAsset, baseAsset, loan, bond, asset) =>
        ratio(oldLoan + oldBond, (oldAsset + baseAsset) / 2) -
        ratio(loan + bond, (asset + oldAsset) / 2),
    ),
    check(
      "liquidity",
      "流动比率改善",
      "本年FN21/FN54 − 上年FN21/FN54 > 0",
      [n(21), n(54), p(21), p(54)],
      (assets, debt, oldAssets, oldDebt) =>
        ratio(assets, debt) - ratio(oldAssets, oldDebt),
    ),
    check(
      "margin",
      "毛利率改善",
      "本年(收入−成本)/收入 − 上年同口径 > 0",
      [n(74), n(75), p(74), p(75)],
      (sales, cost, oldSales, oldCost) =>
        ratio(sales - cost, sales) - ratio(oldSales - oldCost, oldSales),
    ),
    check(
      "turnover",
      "资产周转改善",
      "本年收入/期初资产 − 上年收入/期初资产 > 0",
      [n(74), p(40), p(74), b(40)],
      (sales, assets, oldSales, oldAssets) =>
        ratio(sales, assets) - ratio(oldSales, oldAssets),
    ),
  ];
  const issuance = context.ordinarySharesIssued;
  const knownIssuance =
    issuance &&
    issuance.asOf === now?.reportDate &&
    issuance.unit === "股" &&
    issuance.source &&
    (!context.strict ||
      (!!issuance.availableFrom && issuance.availableFrom <= context.asOf)) &&
    issuance.value !== null &&
    Number.isFinite(issuance.value) &&
    issuance.value >= 0;
  checks.splice(6, 0, {
    id: "no-issuance",
    label: "未发行普通股",
    formula: "该完整年度经认证普通股发行数 = 0；不以股本余额或吸收投资现金替代",
    value: knownIssuance ? issuance.value : null,
    matched: knownIssuance ? issuance.value === 0 : null,
    reason: knownIssuance
      ? null
      : "缺少同年度普通股发行事实，股本余额不证明未发行",
    inputs: issuance
      ? [
          {
            reportDate: issuance.asOf,
            code: "ordinary-share-issuance",
            value: knownIssuance ? issuance.value : null,
            unit: "股",
            sourceSha256: issuance.source,
            reason: knownIssuance ? null : "发行事实未取得当时可见资格",
          },
        ]
      : [],
  });
  if (now?.financialCompany !== false)
    for (const item of checks) {
      item.matched = null;
      item.reason = "金融行业或行业身份未知，不套用非金融年度模型";
    }
  const score = checks.every((c) => c.matched !== null)
    ? checks.filter((c) => c.matched).length
    : null;
  const market = context.marketCapitalization,
    debt = context.interestBearingDebt;
  const fact = (
    value: FinancialTheoryFact | undefined,
    expectedDate: string,
    label: string,
  ): FinancialTheoryEvidence => ({
    reportDate: expectedDate,
    code: label,
    value:
      value?.asOf === expectedDate &&
      value.unit === "元" &&
      value.source &&
      value.value !== null &&
      Number.isFinite(value.value) &&
      value.value >= 0
        ? value.value
        : null,
    unit: "元",
    sourceSha256: value?.source ?? "",
    reason: value?.reason ?? `缺少${expectedDate}已认证${label}`,
  });
  const capital = fact(market, context.asOf, "同日总市值"),
    borrowing = fact(debt, now?.reportDate ?? "", "有息负债");
  const ev = check(
    "enterprise-value",
    "企业价值",
    "同日总市值 + 已认证有息负债 − 货币资金",
    [capital, borrowing, n(8)],
    (cap, loans, cash) => cap + loans - cash,
  );
  // Current interest-bearing debt is needed to remove financing liabilities from NWC.
  const invested = check(
    "invested-capital",
    "投入资本",
    "流动资产 − 货币资金 − (流动负债 − 短期借款 − 一年内到期非流动负债) + 净固定资产",
    [n(21), n(8), n(54), n(41), n(52), n(27)],
    (ca, cash, cl, short, currentLong, fixed) =>
      ca - cash - (cl - short - currentLong) + fixed,
  );
  const ebit = n(207);
  const specialProductionAssets = [n(31), n(32)];
  const special = specialProductionAssetsQualification(specialProductionAssets);
  const financialIndustryKnown = now?.financialCompany === true;
  const nonFinancialKnown = now?.financialCompany === false;
  const nonpositiveEv = ev.value !== null && ev.value <= 0;
  const nonpositiveInvested = invested.value !== null && invested.value <= 0;
  const eligible =
    special.certifiedZero &&
    nonFinancialKnown &&
    ev.value !== null &&
    ev.value > 0 &&
    invested.value !== null &&
    invested.value > 0 &&
    ebit.value !== null;
  const knownRejection =
    financialIndustryKnown ||
    nonpositiveEv ||
    (special.certifiedZero && nonFinancialKnown && nonpositiveInvested);
  return {
    version: financialTheoryVersion,
    reportDate: now?.reportDate ?? null,
    announcementDate: now?.announcementDate ?? null,
    availableFrom: now?.availableFrom ?? null,
    fScore: {
      score,
      known: checks.filter((c) => c.matched !== null).length,
      matched: score === null ? null : score >= 8,
      checks,
    },
    magic: {
      eligible,
      matched: eligible ? true : knownRejection ? false : null,
      earningsYield: eligible ? ebit.value! / ev.value! : null,
      returnOnCapital: eligible ? ebit.value! / invested.value! : null,
      enterpriseValue: ev,
      investedCapital: invested,
      ebit,
      specialProductionAssets,
      reason: eligible
        ? null
        : financialIndustryKnown
          ? "金融行业不套用非金融年度模型"
          : nonpositiveEv
            ? "企业价值非正，无法计算盈利收益率"
            : !special.certifiedZero
              ? special.reason
              : !nonFinancialKnown
                ? "金融行业或行业身份未知"
                : nonpositiveInvested
                  ? "投入资本非正，无法计算资本回报率"
                  : "市值、有息负债、投入资本或EBIT证据不足/分母非正",
    },
    warning:
      "本地财务代理：合并净利润与长期借款/债券口径不等于原研究所有定义；本地EV采用短借、一年内到期非流动负债、长借、债券四项，不代表所有融资负债。当前下载版本未认证历史首次披露。源零值不作为已认证业务零。",
  };
}

export type FinancialTheoryResult = ReturnType<typeof evaluateFinancialTheory>;
/** Ties receive equal factor ranks; symbol is used only for the final tie break. */
export function rankFinancialTheory(
  rows: readonly { symbol: string; result: FinancialTheoryResult }[],
  preset: "f-score" | "magic-formula",
  count = 20,
) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("持仓数量必须为正整数");
  if (new Set(rows.map((r) => r.symbol)).size !== rows.length)
    throw new Error("证券池包含重复证券");
  const usable = rows.filter((r) =>
    preset === "f-score"
      ? r.result.fScore.matched === true
      : r.result.magic.eligible,
  );
  const rank = (value: number, values: number[]) =>
    1 + values.filter((other) => other > value).length;
  const scores = usable.map((r) => ({
    symbol: r.symbol,
    score:
      preset === "f-score"
        ? -r.result.fScore.score!
        : rank(
            r.result.magic.earningsYield!,
            usable.map((x) => x.result.magic.earningsYield!),
          ) +
          rank(
            r.result.magic.returnOnCapital!,
            usable.map((x) => x.result.magic.returnOnCapital!),
          ),
  }));
  scores.sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));
  return {
    version: financialTheoryVersion,
    preset,
    rebalance: "first-trading-day-of-year" as const,
    positions: scores
      .slice(0, count)
      .map((row, i) => ({ ...row, rank: i + 1, weight: 1 / count })),
    cashWeight: 1 - Math.min(scores.length, count) / count,
  };
}
