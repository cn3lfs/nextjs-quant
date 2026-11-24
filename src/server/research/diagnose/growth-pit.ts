import { createHash } from "node:crypto";
import { readSnapshot } from "tstdx/local";
import type { FinancialReportSnapshot } from "tstdx/financial-model";
import {
  createTheoryStructureRule,
  studyWarmup,
  type StrategyObjectInput,
} from "trading-strategies";
import { researchCanslimHighSeries } from "trading-strategies/research/canslim/research-canslim-high";
import { researchSepaSeries } from "trading-strategies/research/canslim/research-sepa";
import type { Bar } from "trading-strategy-core/bars";
import { ma } from "trading-strategy-core/indicators";
import { readLocalFinancialHistory } from "../../data-sources/tdx/local-financial-files";
import {
  buildCanslimPitSeries,
  type CanslimPitEvaluation,
} from "../../financial/canslim-pit-series";
import {
  buildSepaPitSeries,
  type SepaPitEvaluation,
} from "../../financial/sepa-pit-series";
import type { PitDuplicateIssue } from "../../financial/pit-report-input";
import type { FrozenLabBacktest } from "../lab-backtest";
import type { CanslimPitDisclosure } from "./types";

export const MARKET_REGIME_SYMBOL = "sh000300";
const marketBoundary =
  "沪深300本地未复权已完成日线，目标交易日缺少当日行情时按未知处理并禁入。" +
  "沿用 CANSLIM 二值 M1/M3：收盘严格高于含当日 MA250，且近20日分布日少于5个。" +
  "收盘低于前收且成交量大于前量才计分布日。少于250根或最近250根收盘/成交量无效时禁入。" +
  "MA50 与25日分布日仅作观察。M2跟进日及上证指数基准日历独立于本过滤器。";

export type MarketRegimeDay = {
  date: string;
  indexDate: string | null;
  allowed: boolean;
  close: number | null;
  ma50: number | null;
  ma250: number | null;
  distributionDays20: number | null;
  distributionDays25: number | null;
  reason:
    | "allowed"
    | "below-ma250"
    | "distribution"
    | "insufficient-history"
    | "invalid-history"
    | "缺少当日沪深300行情";
};

export function buildMarketRegimeSeries(
  indexBars: readonly Bar[],
): MarketRegimeDay[] {
  // Mask invalid inputs before the rolling mean so a valid later window can recover.
  const valid = (bar: Bar) =>
    Number.isFinite(bar.close) &&
    bar.close > 0 &&
    Number.isFinite(bar.volume) &&
    bar.volume > 0;
  const bad = [0];
  const distributions = [0];
  const sanitized = indexBars.map((bar, index) => {
    const prior = indexBars[index - 1];
    if (prior && bar.date <= prior.date)
      throw new Error("M 大盘日线日期必须严格升序排列");
    const usable = valid(bar);
    bad.push(bad[index]! + Number(!usable));
    distributions.push(
      distributions[index]! +
        Number(
          usable &&
            !!prior &&
            valid(prior) &&
            bar.close < prior.close &&
            bar.volume > prior.volume,
        ),
    );
    return usable ? bar : { ...bar, close: 0 };
  });
  const mean50 = ma(sanitized, 50);
  const mean250 = ma(sanitized, 250);
  const complete = (end: number, size: number) =>
    end >= size && bad[end] === bad[end - size];
  return indexBars.map((bar, index) => {
    const end = index + 1;
    const distributionDays = (size: number) =>
      complete(end, size + 1)
        ? distributions[end]! - distributions[end - size]!
        : null;
    const distributionDays20 = distributionDays(20);
    const ma250 = complete(end, 250) ? mean250[index]! : null;
    const reason =
      end < 250
        ? "insufficient-history"
        : ma250 === null
          ? "invalid-history"
          : bar.close <= ma250
            ? "below-ma250"
            : distributionDays20! >= 5
              ? "distribution"
              : "allowed";
    return {
      date: bar.date,
      indexDate: bar.date,
      allowed: reason === "allowed",
      close: valid(bar) ? bar.close : null,
      ma50: complete(end, 50) ? mean50[index]! : null,
      ma250,
      distributionDays20,
      distributionDays25: distributionDays(25),
      reason,
    };
  });
}

export function evaluateMarketRegimeAtDates(
  indexBars: readonly Bar[],
  targetDates: readonly string[],
) {
  const lastDate = targetDates.reduce(
    (last, date) => (date > last ? date : last),
    "",
  );
  const bars = indexBars.filter((bar) => bar.date <= lastDate);
  const series = buildMarketRegimeSeries(bars);
  const indexByDate = new Map(bars.map((bar, index) => [bar.date, index]));
  const days = targetDates.map((date): MarketRegimeDay => {
    const index = indexByDate.get(date);
    if (index !== undefined) return series[index]!;
    return {
      date,
      indexDate: null,
      allowed: false,
      close: null,
      ma50: null,
      ma250: null,
      distributionDays20: null,
      distributionDays25: null,
      reason: "缺少当日沪深300行情",
    };
  });
  const counts = { allowedDays: 0, blockedDays: 0, unknownDays: 0 };
  for (const day of days) {
    if (day.allowed) counts.allowedDays++;
    else if (day.reason === "below-ma250" || day.reason === "distribution")
      counts.blockedDays++;
    else counts.unknownDays++;
  }
  return { days, ...counts, boundary: marketBoundary };
}

export const SEPA_VCP_CLOSE_STRATEGY_KEYS = Object.freeze([
  "research-sepa-vcp-close-price",
  "research-sepa-vcp-close-pit",
  "research-sepa-vcp-close-pit-strict-finance",
] as const);
export type SepaVcpCloseStrategyKey =
  (typeof SEPA_VCP_CLOSE_STRATEGY_KEYS)[number];
export const isSepaVcpCloseStrategyKey = (
  key: string,
): key is SepaVcpCloseStrategyKey =>
  (SEPA_VCP_CLOSE_STRATEGY_KEYS as readonly string[]).includes(key);

export const GROWTH_PIT_STRATEGY_KEYS = Object.freeze([
  "research-canslim-pit",
  "research-canslim-pit-m",
  "research-canslim-pit-stop8",
  "research-canslim-pit-stop7",
  "research-canslim-pit-ma50",
  "research-canslim-pit-ma20",
  "research-sepa-pit",
  "research-sepa-pit-m",
  "research-sepa-pit-stop8",
  "research-sepa-pit-ma50",
  ...SEPA_VCP_CLOSE_STRATEGY_KEYS,
] as const);
export type GrowthPitStrategyKey = (typeof GROWTH_PIT_STRATEGY_KEYS)[number];
export const isGrowthPitStrategyKey = (
  key: string,
): key is GrowthPitStrategyKey =>
  (GROWTH_PIT_STRATEGY_KEYS as readonly string[]).includes(key);

export type GrowthExitAblation =
  | { kind: "5-bar" }
  | { kind: "fixed-stop"; fraction: 0.07 | 0.08 }
  | { kind: "ma-close-breakdown"; period: 20 | 50 };

const strategyVariants = {
  "research-canslim-pit": ["canslim", false, { kind: "5-bar" }],
  "research-canslim-pit-m": ["canslim", true, { kind: "5-bar" }],
  "research-canslim-pit-stop8": [
    "canslim",
    true,
    { kind: "fixed-stop", fraction: 0.08 },
  ],
  "research-canslim-pit-stop7": [
    "canslim",
    true,
    { kind: "fixed-stop", fraction: 0.07 },
  ],
  "research-canslim-pit-ma50": [
    "canslim",
    true,
    { kind: "ma-close-breakdown", period: 50 },
  ],
  "research-canslim-pit-ma20": [
    "canslim",
    true,
    { kind: "ma-close-breakdown", period: 20 },
  ],
  "research-sepa-pit": ["sepa", false, { kind: "5-bar" }],
  "research-sepa-pit-m": ["sepa", true, { kind: "5-bar" }],
  "research-sepa-pit-stop8": [
    "sepa",
    true,
    { kind: "fixed-stop", fraction: 0.08 },
  ],
  "research-sepa-pit-ma50": [
    "sepa",
    true,
    { kind: "ma-close-breakdown", period: 50 },
  ],
} as const satisfies Record<
  Exclude<GrowthPitStrategyKey, SepaVcpCloseStrategyKey>,
  readonly ["canslim" | "sepa", boolean, GrowthExitAblation]
>;

export function growthPitWarmupBars(key: GrowthPitStrategyKey) {
  if (isSepaVcpCloseStrategyKey(key)) return studyWarmup("theory-vcp-close");
  return studyWarmup("research-growth");
}

const vcpCloseMaxBars = 6;

export function growthPitRulesFor(
  key: GrowthPitStrategyKey,
): Pick<StrategyObjectInput, "entry" | "exit"> {
  if (isSepaVcpCloseStrategyKey(key))
    return {
      entry: { kind: "external", id: key, side: "entry" },
      exit: { maxBars: vcpCloseMaxBars },
    };
  const [family, , ablation] = strategyVariants[key];
  let exit: StrategyObjectInput["exit"];
  if (ablation.kind === "fixed-stop")
    exit = { stop: { kind: "fixed", fraction: ablation.fraction } };
  else if (ablation.kind === "ma-close-breakdown")
    exit = { rule: { kind: "external", id: key, side: "exit" } };
  else if (family === "canslim")
    exit = {
      rule: { kind: "study-rule", strategy: "research-growth", side: "exit" },
    };
  // The engine counts the fill bar. Six completed bars means five closes after the fill, like research-growth.
  else exit = { maxBars: 6 };
  return { entry: { kind: "external", id: key, side: "entry" }, exit };
}

export function buildGrowthExitSeries(
  key: GrowthPitStrategyKey,
  bars: readonly Bar[],
) {
  if (isSepaVcpCloseStrategyKey(key)) return bars.map(() => false);
  const [, , exit] = strategyVariants[key];
  if (exit.kind !== "ma-close-breakdown") return bars.map(() => false);
  const averages = ma(bars, exit.period);
  return bars.map((bar, index) => {
    const mean = averages[index];
    return mean == null ? null : bar.close < mean;
  });
}

type SepaDisclosure = Omit<SepaPitEvaluation, "days" | "duplicateRecordIssues">;
type MarketDisclosure = Omit<
  ReturnType<typeof evaluateMarketRegimeAtDates>,
  "days"
> & {
  symbol: typeof MARKET_REGIME_SYMBOL;
  source: "tdx-local" | "provided-snapshot";
  inputHash: string;
  latestIndexDate: string | null;
};
export type GrowthPitDisclosure = CanslimPitDisclosure & {
  checkCoverage?: CanslimPitEvaluation["checkCoverage"];
  sepaPit?: SepaDisclosure;
  marketRegime?: MarketDisclosure;
  /** The engine gives a simultaneous close exit priority over entry. */
  exitSuppressedEntrySignals?: number;
  funnel: {
    priceSignals: number;
    trendVcpSignals: number;
    pitFinanceSignals: number;
    marketRegimeSignals: number;
    strictPitFinanceSignals?: number;
    tolerantPitFinanceSignals?: number;
  };
  duplicateIssues: PitDuplicateIssue[];
} & (
    | { exitAblation: GrowthExitAblation; maxBars?: never }
    | { maxBars: 6; exitAblation?: never }
  );

export type GrowthPitSignalOptions = {
  tdxRoot: string;
  /** Explicit frozen completed index bars, useful for sharing one snapshot across cells. */
  indexBars?: readonly Bar[];
  /** Full benchmark calendar including warmup for SEPA. Defaults to symbol dates. */
  signalCalendar?: readonly string[];
  readFinancialHistory?: (
    root: string,
    symbol: string,
    options: NonNullable<Parameters<typeof readLocalFinancialHistory>[2]>,
  ) => Promise<{
    reports: readonly FinancialReportSnapshot[];
    issues: readonly unknown[];
  }>;
};

export async function readGrowthMarketBars(root: string, end: string) {
  const now = Date.now();
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const afterClose = now >= Date.parse(`${today}T15:00:00+08:00`);
  try {
    const { bars } = await readSnapshot(root, MARKET_REGIME_SYMBOL, "day");
    return bars.filter(
      (bar) =>
        bar.date <= end &&
        (bar.date < today || (afterClose && bar.date === today)),
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof Error && error.message === "行情文件为空")
    )
      return [];
    throw error;
  }
}

export async function attachGrowthPitSignals(
  key: GrowthPitStrategyKey,
  frozen: Pick<FrozenLabBacktest, "request">,
  options: GrowthPitSignalOptions,
): Promise<GrowthPitDisclosure[]> {
  if (isSepaVcpCloseStrategyKey(key))
    return attachSepaVcpCloseSignals(key, frozen, options);
  const [family, usesMarket, exitAblation] = strategyVariants[key];
  const { instruments, start, end } = frozen.request;
  const warmup = growthPitWarmupBars(key);
  const readHistory = options.readFinancialHistory ?? readLocalFinancialHistory;
  const indexBars = usesMarket
    ? (
        options.indexBars ?? (await readGrowthMarketBars(options.tdxRoot, end))
      ).filter((bar) => bar.date <= end)
    : [];
  const targetDates = usesMarket
    ? [
        ...new Set(
          instruments.flatMap((instrument) =>
            instrument.signalBars.map((bar) => bar.date),
          ),
        ),
      ].filter((date) => date <= end)
    : [];
  const market = usesMarket
    ? evaluateMarketRegimeAtDates(indexBars, targetDates)
    : null;
  const marketByDate = new Map(market?.days.map((day) => [day.date, day]));
  const marketIdentity =
    market &&
    ({
      symbol: MARKET_REGIME_SYMBOL,
      source: options.indexBars
        ? ("provided-snapshot" as const)
        : ("tdx-local" as const),
      inputHash: createHash("sha256")
        .update(
          JSON.stringify(
            indexBars.map(({ date, close, volume }) => [date, close, volume]),
          ),
        )
        .digest("hex"),
      latestIndexDate: indexBars.at(-1)?.date ?? null,
      boundary: market.boundary,
    } satisfies Omit<
      MarketDisclosure,
      "allowedDays" | "blockedDays" | "unknownDays"
    >);
  const disclosures: GrowthPitDisclosure[] = [];
  for (const instrument of instruments) {
    const { symbol, signalBars } = instrument;
    const history = await readHistory(options.tdxRoot, symbol, {
      asOf: end,
      strict: true,
      limit: 200,
    });
    const scoredBars = signalBars.filter(
      ({ date }, index) => index >= warmup && date >= start && date <= end,
    );
    const marketCounts = { allowedDays: 0, blockedDays: 0, unknownDays: 0 };
    const exit = buildGrowthExitSeries(key, signalBars);
    const funnel: GrowthPitDisclosure["funnel"] = {
      priceSignals: 0,
      trendVcpSignals: 0,
      pitFinanceSignals: 0,
      marketRegimeSignals: 0,
    };

    const canslim =
      family === "canslim"
        ? buildCanslimPitSeries(history.reports, scoredBars, history)
        : null;
    const sepa =
      family === "sepa"
        ? buildSepaPitSeries(history.reports, scoredBars, history)
        : null;
    const prices = canslim
      ? researchCanslimHighSeries("canslim-high-98", signalBars)
      : null;
    const sepaPrices =
      sepa && scoredBars.length
        ? researchSepaSeries(
            "sepa-vcp-close",
            signalBars,
            options.signalCalendar,
            signalBars.indexOf(scoredBars[0]!),
          )
        : null;
    const priceFacts = new Map(
      scoredBars.map((bar, index) => [bar.date, index]),
    );
    let strictPitFinanceSignals = 0;
    let tolerantPitFinanceSignals = 0;
    let exitSuppressedEntrySignals = 0;
    const signals = signalBars.map((bar, index) => {
      const { date } = bar;
      const pitIndex = priceFacts.get(date);
      const row = { id: key, date, availableAt: date, exit: exit[index]! };
      if (pitIndex === undefined) return { ...row, entry: null };
      const sepaPrice = sepaPrices?.[index];
      const trendVcp = sepaPrice?.entry ?? prices?.[index]?.entry ?? false;
      const pivot = sepaPrice?.pattern?.facts.pivot?.price;
      const volume = sepaPrice?.volume;
      // Same breakout band and volume as sepa-vcp-close, before its trend and VCP quality gates.
      const price =
        trendVcp ||
        (pivot != null &&
          volume != null &&
          signalBars[index - 1]!.close <= pivot * 1.01 &&
          bar.close > pivot * 1.01 &&
          bar.close <= pivot * 1.05 &&
          bar.volume >= volume.average * volume.threshold);
      const sepaDay = sepa?.days[pitIndex];
      const finance =
        trendVcp &&
        (canslim?.days[pitIndex]?.qualified ??
          sepaDay?.qualifiedTolerant ??
          false);
      const regime = marketByDate.get(date);
      const entry = finance && (!usesMarket || regime?.allowed === true);
      if (regime?.allowed) marketCounts.allowedDays++;
      else if (
        regime?.reason === "below-ma250" ||
        regime?.reason === "distribution"
      )
        marketCounts.blockedDays++;
      else if (usesMarket) marketCounts.unknownDays++;
      if (price) funnel.priceSignals++;
      if (trendVcp) funnel.trendVcpSignals++;
      if (finance) funnel.pitFinanceSignals++;
      if (entry) funnel.marketRegimeSignals++;
      if (entry && row.exit === true) exitSuppressedEntrySignals++;
      if (trendVcp && sepaDay?.qualifiedStrict) strictPitFinanceSignals++;
      if (trendVcp && sepaDay?.gate === "tolerant-pass")
        tolerantPitFinanceSignals++;
      return { ...row, entry };
    });
    instrument.external = {
      ...instrument.external,
      signals: [
        ...(instrument.external?.signals ?? []).filter(
          (signal) => signal.id !== key,
        ),
        ...signals,
      ],
    };
    const pit = canslim ?? sepa!;
    let sepaPit: SepaDisclosure | undefined;
    if (sepa) {
      const {
        days: _days,
        duplicateRecordIssues: _duplicates,
        ...summary
      } = sepa;
      sepaPit = summary;
      Object.assign(funnel, {
        strictPitFinanceSignals,
        tolerantPitFinanceSignals,
      });
    }
    disclosures.push({
      symbol,
      strictReportCount: pit.strictReportCount,
      reportDateRange: pit.reportDateRange,
      qualifiedDays:
        canslim?.qualifiedDays ??
        (sepa?.strictPassDays ?? 0) + (sepa?.tolerantPassDays ?? 0),
      missingDays: canslim?.missingDays ?? sepa?.incompleteDays ?? 0,
      conflictDays: canslim?.conflictDays ?? 0,
      priceSignalCount: funnel.priceSignals,
      pitFilteredSignalCount: funnel.pitFinanceSignals,
      sourceIssuesCount: history.issues.length,
      boundary:
        pit.boundary +
        (sepa
          ? " SEPA 采用 sepa-vcp-close 的收盘趋势/VCP 规则及严格或宽松财务通过。价量层统计可识别枢纽的收盘放量突破。外部布尔信号按回测开盘规则执行，次日枢纽限价未接入。"
          : " CANSLIM 保留 canslim-high-98 入场与 C1/A1/A2 门槛。"),
      ...(canslim && { checkCoverage: canslim.checkCoverage }),
      ...(sepaPit && { sepaPit }),
      ...(marketIdentity && {
        marketRegime: { ...marketIdentity, ...marketCounts },
      }),
      exitAblation,
      ...(exitAblation.kind === "ma-close-breakdown" && {
        exitSuppressedEntrySignals,
      }),
      funnel,
      duplicateIssues: canslim?.duplicateIssues ?? sepa!.duplicateRecordIssues,
    });
  }
  return disclosures;
}

async function attachSepaVcpCloseSignals(
  key: SepaVcpCloseStrategyKey,
  frozen: Pick<FrozenLabBacktest, "request">,
  options: GrowthPitSignalOptions,
): Promise<GrowthPitDisclosure[]> {
  const { instruments, start, end } = frozen.request;
  const warmup = growthPitWarmupBars(key);
  const priceOnly = key === "research-sepa-vcp-close-price";
  const strictFinance = key === "research-sepa-vcp-close-pit-strict-finance";
  const readHistory = options.readFinancialHistory ?? readLocalFinancialHistory;
  const disclosures: GrowthPitDisclosure[] = [];
  for (const instrument of instruments) {
    const { symbol, signalBars } = instrument;
    const scoredBars = signalBars.filter(
      ({ date }, index) => index >= warmup && date >= start && date <= end,
    );
    const history = priceOnly
      ? null
      : await readHistory(options.tdxRoot, symbol, {
          asOf: end,
          strict: true,
          limit: 200,
        });
    const pit = history
      ? buildSepaPitSeries(history.reports, scoredBars, history)
      : null;
    const pitByDate = new Map(pit?.days.map((day) => [day.date, day]));
    const priceRule = createTheoryStructureRule(
      "theory-vcp-close",
      signalBars,
    )!;
    const funnel: GrowthPitDisclosure["funnel"] = {
      priceSignals: 0,
      trendVcpSignals: 0,
      pitFinanceSignals: 0,
      marketRegimeSignals: 0,
      ...(pit && { strictPitFinanceSignals: 0, tolerantPitFinanceSignals: 0 }),
    };
    const signals = signalBars.map(({ date }, index) => {
      const row = { id: key, date, availableAt: date, exit: false };
      if (index < warmup || date < start || date > end)
        return { ...row, entry: null };
      const priceEntry = priceRule(index, {
        entry: 0,
        entryIndex: index,
      }).enter;
      const finance = pitByDate.get(date);
      const pitPass = strictFinance
        ? finance?.qualifiedStrict
        : finance?.qualifiedTolerant;
      const entry = priceEntry && (priceOnly || pitPass === true);
      if (priceEntry) {
        funnel.priceSignals++;
        funnel.trendVcpSignals++;
        if (finance?.qualifiedStrict) funnel.strictPitFinanceSignals!++;
        if (finance?.gate === "tolerant-pass")
          funnel.tolerantPitFinanceSignals!++;
        if (pitPass) funnel.pitFinanceSignals++;
      }
      if (entry) funnel.marketRegimeSignals++;
      return { ...row, entry };
    });
    instrument.external = {
      ...instrument.external,
      signals: [
        ...(instrument.external?.signals ?? []).filter(
          (signal) => signal.id !== key,
        ),
        ...signals,
      ],
    };
    let sepaPit: SepaDisclosure | undefined;
    if (pit) {
      const {
        days: _days,
        duplicateRecordIssues: _duplicates,
        ...summary
      } = pit;
      sepaPit = summary;
    }
    disclosures.push({
      symbol,
      strictReportCount: pit?.strictReportCount ?? 0,
      reportDateRange: pit?.reportDateRange ?? null,
      qualifiedDays: strictFinance
        ? (pit?.strictPassDays ?? 0)
        : (pit?.strictPassDays ?? 0) + (pit?.tolerantPassDays ?? 0),
      missingDays: pit?.incompleteDays ?? 0,
      conflictDays: 0,
      priceSignalCount: funnel.priceSignals,
      pitFilteredSignalCount: funnel.pitFinanceSignals,
      sourceIssuesCount: history?.issues.length ?? 0,
      boundary:
        `直接使用 theory-vcp-close 日线入场，计入成交日持有 ${vcpCloseMaxBars} 根后请求退出。` +
        (pit
          ? `${pit.boundary} 财务缺失时禁入。${strictFinance ? "四项均须达到严格阈值。" : "接受既有严格档或宽松档财务通过。"}`
          : "纯价格基线，不读取财报。"),
      ...(sepaPit && { sepaPit }),
      maxBars: vcpCloseMaxBars,
      funnel,
      duplicateIssues: pit?.duplicateRecordIssues ?? [],
    });
  }
  return disclosures;
}
