import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "~/lib/domain";
import { calculateValuation } from "~/lib/valuation";
import {
  financialQuality,
  type FinancialQualityArchive,
} from "./financial-quality";
import type { ValuationScenario } from "./valuation-scenario";
import { queryIndustryContext } from "./hithink-context";
import {
  solvencyEvidence,
  solvencyProfiles,
  querySolvency,
} from "./hithink-solvency";
import { financialGrowth } from "./financial-growth";
import { incomeScopeEvidence, queryIncomeScope } from "./hithink-income-scope";
import { revenueReconciliation } from "./revenue-reconciliation";
import {
  capitalEventsEvidence,
  capitalEventProfiles,
  queryCapitalEvents,
} from "./hithink-capital-events";
import {
  macroDefinitions,
  macroEvidence,
  macroProfiles,
  queryMacro,
} from "./hithink-macro";
import {
  forecastEvidence,
  forecastYear,
  queryForecast,
} from "./hithink-forecast";
import {
  ownershipEvidence,
  ownershipProfiles,
  queryOwnership,
} from "./hithink-ownership";
import {
  businessEvidence,
  businessProfiles,
  queryBusiness,
} from "./hithink-business";
import { completedBarFilter } from "./screening";
import { evidenceEnvelope } from "./evidence";
import { get, put } from "./db";
import { isAStock } from "./tdx";
import type { ValuationMethod } from "./valuation-method";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function fundamentalPrice(source: Snapshot, now: number): Evidence {
  if (
    !isAStock(source.symbol) ||
    source.period !== "day" ||
    source.adjustment !== "none" ||
    source.historicalAsOf
  )
    throw new Error(
      "基本面资料复核需要当前A股不复权日线，不能拼接历史时点与当前财务",
    );
  if (!Number.isFinite(source.createdAt) || !Number.isFinite(now))
    throw new Error("行情资料时点无效");
  let previous = "";
  for (const bar of source.bars) {
    const time = Date.parse(bar.date);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== bar.date ||
      bar.date <= previous ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0
    )
      throw new Error("收盘价日期、顺序或数值无效");
    previous = bar.date;
  }
  const completed = completedBarFilter("day", now);
  const last = source.bars.filter((bar) => completed(bar.date)).at(-1);
  if (!last) throw new Error("缺少已完成日线收盘价");
  const payload = {
    symbol: source.symbol,
    source: source.source,
    kind: "completed-day-close",
    adjustment: source.adjustment,
    date: last.date,
    close: last.close,
  };
  const envelope = evidenceEnvelope(payload, {
    source: source.source,
    symbol: source.symbol,
    type: "quote-financial",
    asOf: last.date,
    publishedAt: null,
    fetchedAt: source.createdAt,
    currency: "CNY",
    unit: { price: "元" },
    adjustment: "none",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "最近已完成日线收盘价，不是实时成交价；交易日缺口和公司行动未独立核验",
      ...(now - Date.parse(`${last.date}T00:00:00+08:00`) > 5 * 86400000
        ? ["价格超过5个自然日，不能默认视为当前价格"]
        : []),
    ],
  });
  return {
    id: `fundamental-price-${envelope.payloadHash}`,
    source: source.source,
    asOf: last.date,
    text: JSON.stringify(payload),
    envelope,
  };
}
export function buildFundamentalDossier(
  finance: FinancialQualityArchive,
  source: Snapshot,
  context: Evidence[],
  mode: ValuationMethod,
  scenario: ValuationScenario | undefined,
  now = Date.now(),
) {
  if (
    !Number.isFinite(finance.createdAt) ||
    finance.facts.symbol !== source.symbol
  )
    throw new Error("财务与行情档案证券或时点不匹配");
  const financeHash = hash({
    facts: finance.facts,
    evidence: finance.evidence,
    missingProfiles: finance.missingProfiles,
  });
  if (
    finance.hash !== financeHash ||
    finance.id !== `financial-quality-${financeHash}` ||
    JSON.stringify(
      financialQuality(source.symbol, finance.evidence, finance.createdAt),
    ) !== JSON.stringify(finance.facts)
  )
    throw new Error("财务档案内容或计算版本校验失败");
  const recent = finance.facts.annual.slice(-3);
  if (
    recent.length < 3 ||
    recent.some(
      (row, index) =>
        row.netProfit.value === null ||
        row.amounts.revenue.value === null ||
        row.amounts.assets.value === null ||
        (index > 0 &&
          Number(row.period.slice(0, 4)) !==
            Number(recent[index - 1]!.period.slice(0, 4)) + 1),
    )
  )
    throw new Error("最近三个连续年度的关键财务不足，尚不能生成基本面资料复核");
  const price = fundamentalPrice(source, now);
  for (const entry of context) {
    if (
      !entry.envelope ||
      (entry.envelope.source === "hithink-macro-query"
        ? entry.envelope.symbol !== null
        : entry.envelope.symbol !== source.symbol) ||
      ![
        "hithink-basicinfo-query",
        "hithink-industry-query",
        "hithink-business-query",
        "hithink-management-query",
        "hithink-insresearch-query",
        "hithink-macro-query",
        "hithink-finance-query",
        "hithink-event-query",
      ].includes(entry.envelope.source) ||
      hash(JSON.parse(entry.text)) !== entry.envelope.payloadHash
    )
      throw new Error("研究背景证据校验失败");
    if (entry.envelope.source === "hithink-business-query") {
      const payload = JSON.parse(entry.text);
      const verified = businessEvidence(
        source.symbol,
        payload.year,
        payload.profile,
        payload.query,
        payload.pages,
        entry.envelope.fetchedAt,
      );
      if (
        verified.text !== entry.text ||
        verified.id !== entry.id ||
        JSON.stringify(verified.envelope) !== JSON.stringify(entry.envelope) ||
        payload.year !== Number(recent.at(-1)!.period.slice(0, 4))
      )
        throw new Error("经营资料与财务年度或解析版本不一致");
    }
    if (entry.envelope.source === "hithink-management-query") {
      const payload = JSON.parse(entry.text);
      const verified = ownershipEvidence(
        source.symbol,
        payload.year,
        payload.profile,
        payload.query,
        payload.response,
        entry.envelope.fetchedAt,
      );
      if (
        verified.text !== entry.text ||
        verified.id !== entry.id ||
        JSON.stringify(verified.envelope) !== JSON.stringify(entry.envelope) ||
        payload.year !== Number(recent.at(-1)!.period.slice(0, 4))
      )
        throw new Error("股权资料与财务年度或解析版本不一致");
    }
    if (entry.envelope.source === "hithink-insresearch-query") {
      const payload = JSON.parse(entry.text);
      const verified = forecastEvidence(
        source.symbol,
        payload.startYear,
        payload.query,
        payload.response,
        entry.envelope.fetchedAt,
      );
      if (
        verified.text !== entry.text ||
        verified.id !== entry.id ||
        JSON.stringify(verified.envelope) !== JSON.stringify(entry.envelope) ||
        payload.startYear !== forecastYear(now)
      )
        throw new Error("盈利预测年度或解析版本不一致");
    }
    if (entry.envelope.source === "hithink-macro-query") {
      const payload = JSON.parse(entry.text);
      const verified = macroEvidence(
        payload.profile,
        payload.query,
        payload.response,
        entry.envelope.fetchedAt,
      );
      if (
        verified.text !== entry.text ||
        verified.id !== entry.id ||
        JSON.stringify(verified.envelope) !== JSON.stringify(entry.envelope)
      )
        throw new Error("宏观资料定义或解析版本不一致");
    }
    if (entry.envelope.source === "hithink-event-query") {
      const payload = JSON.parse(entry.text);
      const verified = capitalEventsEvidence(
        source.symbol,
        payload.year,
        payload.profile,
        payload.query,
        payload.pages,
        entry.envelope.fetchedAt,
      );
      if (
        verified.text !== entry.text ||
        verified.id !== entry.id ||
        JSON.stringify(verified.envelope) !== JSON.stringify(entry.envelope) ||
        payload.year !== Number(recent.at(-1)!.period.slice(0, 4))
      )
        throw new Error("资本事件年度或解析版本不一致");
    }
    if (entry.envelope.source === "hithink-finance-query") {
      const payload = JSON.parse(entry.text);
      const verified =
        payload.version === "income-scope-1"
          ? incomeScopeEvidence(
              source.symbol,
              payload.year,
              payload.query,
              payload.response,
              entry.envelope.fetchedAt,
            )
          : solvencyEvidence(
              source.symbol,
              payload.year,
              payload.profile,
              payload.query,
              payload.response,
              entry.envelope.fetchedAt,
            );
      if (
        verified.text !== entry.text ||
        verified.id !== entry.id ||
        JSON.stringify(verified.envelope) !== JSON.stringify(entry.envelope) ||
        payload.year !== Number(recent.at(-1)!.period.slice(0, 4))
      )
        throw new Error(
          payload.version === "income-scope-1"
            ? "收入口径资料年度或解析版本不一致"
            : "偿债资料年度或解析版本不一致",
        );
      if (payload.profile === "balance") {
        for (const key of ["assets", "equity"] as const) {
          const archived = recent.at(-1)!.amounts[key].value,
            current = payload.facts.amounts[key];
          if (
            archived !== null &&
            current !== null &&
            Math.abs(archived - current) >
              Math.max(0.01, Math.abs(archived) * Number.EPSILON * 16)
          )
            throw new Error(
              "偿债资料与财务档案资产/权益不一致，请重新获取财务档案",
            );
        }
      }
    }
  }
  if (scenario) {
    const { id, hash: scenarioHash, createdAt, ...content } = scenario;
    if (
      scenario.symbol !== source.symbol ||
      !Number.isFinite(createdAt) ||
      scenarioHash !== hash(content) ||
      id !== `valuation-scenario-${scenarioHash}` ||
      scenario.origin !== "user-assumptions" ||
      scenario.financialEvidenceVerified !== false ||
      scenario.automaticSignals !== false
    )
      throw new Error("估值情景身份或内容校验失败");
    if (
      (mode === "fundamental" && scenario.method !== "fcff-wacc") ||
      (mode === "guo" && scenario.method !== "guo-operating-equity")
    )
      throw new Error("估值情景与研究方法不匹配，不能混用两条路径");
    for (const row of scenario.scenarios) {
      const { name, ...result } = row;
      if (
        JSON.stringify(calculateValuation(row.input)) !== JSON.stringify(result)
      )
        throw new Error("估值情景计算版本校验失败");
    }
  }
  const evidence = [...finance.evidence, price, ...context];
  if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length)
    throw new Error("研究证据ID重复");
  const incomeReconciliation = revenueReconciliation(
    finance.id,
    recent.at(-1)!.period,
    recent.at(-1)!.amounts.revenue.value,
    context,
  );
  const content = {
    version: "fundamental-dossier-9",
    symbol: source.symbol,
    mode,
    finance,
    growth: financialGrowth(finance),
    revenueReconciliation: incomeReconciliation,
    price,
    context,
    scenario: scenario ?? null,
    evidence,
    formalValuationEligible: false,
    missing: [
      ...incomeReconciliation.missing,
      ...capitalEventProfiles
        .filter(
          (profile) =>
            !context.some(
              (entry) =>
                entry.envelope?.source === "hithink-event-query" &&
                JSON.parse(entry.text).profile === profile,
            ),
        )
        .map(
          (profile) =>
            `${profile === "placement" ? "增发" : "配股"}事件资料缺失`,
        ),
      "资本事件查询覆盖及原始公告未完整核验，不能据无记录证明全年未发行新股或无监管风险",
      "财报币种、合并范围、重述及审计意见尚未独立核验；年度资料不覆盖最新季度",
      "客户/供应商名单、管理层/发行事件尚未完整采集",
      ...solvencyProfiles
        .filter(
          (profile) =>
            !context.some(
              (entry) =>
                entry.envelope?.source === "hithink-finance-query" &&
                JSON.parse(entry.text).profile === profile,
            ),
        )
        .map((profile) =>
          profile === "balance"
            ? "资产负债等式及负债率资料缺失"
            : "EBIT、利息支出及带息债务资料缺失",
        ),
      "宏观发布日期/修订版本、PPI当月同比及季度GDP尚未完整核验；国债即期收益率不能自动代替WACC",
      ...macroProfiles
        .filter(
          (profile) =>
            !context.some(
              (entry) =>
                entry.envelope?.source === "hithink-macro-query" &&
                JSON.parse(entry.text).profile === profile,
            ),
        )
        .map((profile) => `${macroDefinitions[profile].label}资料缺失`),
      ...(context.some(
        (entry) => entry.envelope?.source === "hithink-insresearch-query",
      )
        ? ["盈利预测聚合更新时点、机构名单、币种及利润/EPS口径尚未核验"]
        : ["未来三年盈利预测资料缺失"]),
      ...ownershipProfiles
        .filter(
          (profile) =>
            !context.some(
              (entry) =>
                entry.envelope?.source === "hithink-management-query" &&
                JSON.parse(entry.text).profile === profile,
            ),
        )
        .map((profile) =>
          profile === "control"
            ? "控股股东与实控人资料缺失"
            : "同年度股权集中度与总股本缺失",
        ),
      ...businessProfiles
        .filter(
          (profile) =>
            !context.some(
              (entry) =>
                entry.envelope?.source === "hithink-business-query" &&
                JSON.parse(entry.text).profile === profile,
            ),
        )
        .map((profile) =>
          profile === "segments"
            ? "同年度主营构成缺失"
            : "同年度前五大客户销售占比缺失",
        ),
      "F-Score与六维评分未具备完整口径，不能输出总分或以评分断言低估",
      "相对估值、Graham、PEG及市场隐含预期尚未由后端核验计算",
      ...(["hithink-basicinfo-query", "hithink-industry-query"].every(
        (source) => context.some((entry) => entry.envelope?.source === source),
      )
        ? []
        : ["证券及行业背景不完整"]),
      ...(scenario
        ? ["所附估值仅为人工假设场景，不证明公司公允价值或安全边际"]
        : ["未附独立估值场景，不得自行补写利率、增长率或目标价"]),
    ],
  };
  return { id: `fundamental-dossier-${hash(content)}`, ...content };
}
export async function gatherFundamentalContext(
  symbol: string,
  signal?: AbortSignal,
  year = new Date().getFullYear() - 1,
) {
  signal?.throwIfAborted();
  const currentForecastYear = forecastYear();
  const key = `fundamental-context-v9-${symbol}-${year}-${currentForecastYear}`;
  const cached = get<{ createdAt: number; evidence: Evidence[] }>(key);
  const age = cached ? Date.now() - cached.createdAt : Infinity;
  if (cached && age >= 0 && age < 30 * 60000) return cached.evidence;
  try {
    const queries: (() => Promise<Evidence | Evidence[]>)[] = [
      () => queryIndustryContext(symbol, signal),
      ...businessProfiles.map(
        (profile) => () => queryBusiness(symbol, year, profile, signal),
      ),
      ...ownershipProfiles.map(
        (profile) => () => queryOwnership(symbol, year, profile, signal),
      ),
      () => queryForecast(symbol, currentForecastYear, signal),
      ...macroProfiles.map((profile) => () => queryMacro(profile, signal)),
      ...solvencyProfiles.map(
        (profile) => () => querySolvency(symbol, year, profile, signal),
      ),
      () => queryIncomeScope(symbol, year, signal),
      ...capitalEventProfiles.map(
        (profile) => () => queryCapitalEvents(symbol, year, profile, signal),
      ),
    ];
    const evidence: Evidence[] = [];
    for (let i = 0; i < queries.length; i += 2) {
      signal?.throwIfAborted();
      const results = await Promise.allSettled(
        queries.slice(i, i + 2).map((query) => query()),
      );
      signal?.throwIfAborted();
      evidence.push(
        ...results
          .flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          )
          .filter((entry) => entry.envelope),
      );
    }
    signal?.throwIfAborted();
    if (evidence.length)
      put("evidence", key, { createdAt: Date.now(), evidence });
    return evidence;
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}
export type FundamentalDossier = ReturnType<typeof buildFundamentalDossier>;
