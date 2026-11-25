import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import {
  usesStrategyBook,
  type StrategyExternalInputs,
} from "trading-strategies";
import { isDeepStrictEqual } from "node:util";
import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import type { Bar } from "trading-strategy-core/bars";
import { cryptoSymbol, isCryptoSymbol } from "~/lib/market/crypto";
import { beijingClock } from "~/lib/market/market-session";
import { readBars } from "../market/bar-store/read-bars";
import { corporateActions } from "../market/bar-store/corporate-actions";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "../research/corporate-actions";
import { captureLowZoneFinancials } from "../research/validation-financials";
import { readFinancialPoolHistory } from "../data-sources/tdx/local-financial-files";
import { sizeCryptoResearch } from "../research/crypto-sizing";
import { settings } from "../infra/settings";
import { downloadReady } from "../jobs/workflow-scheduler";
import {
  publicDataRoot,
  publicDataStatus,
} from "../data-sources/binance/public-data-store";
import type { PaperAccount } from "./model";
import type { PaperInput } from "./advance";
import { createHash } from "node:crypto";
import { paperCompletedAt } from "./advance-clock";
import { paperSleevePolicy } from "./policy";
import { capturePaperDecisions } from "./decisions";
import { localCalendarReference } from "../market/data-health";
import { loadCnPaperContext } from "./cn-book-context";
import { causalResearchPrices } from "../research/causal-price-basis";
import { PaperRepository } from "../db/paper-repository";

export async function loadPaperInput(
  account: PaperAccount,
  now: number,
  dependencies: {
    bookFacts?: PortfolioRequest["bookFacts"];
    externalBySymbol?: Readonly<Record<string, StrategyExternalInputs>>;
    memberships?: PortfolioRequest["memberships"];
    bookSeeds?: PortfolioRequest["bookSeeds"];
  } = {},
): Promise<PaperInput | null> {
  const config = settings();
  const period = account.candidates[0]!.strategy.period;
  const native = account.candidates.some(
    ({ strategy }) =>
      usesStrategyBook(strategy) ||
      !!strategy.exit.chandelier ||
      !!strategy.exit.timeReentry,
  );
  const policy = native ? account.candidates[0]!.executionPolicy : undefined;
  if (
    native &&
    (!policy ||
      !policy.costs ||
      policy.initial !== account.initial ||
      account.candidates.some(
        (candidate) => !isDeepStrictEqual(candidate.executionPolicy, policy),
      ))
  )
    throw new Error(
      "新纸面策略缺少同版本冻结executionPolicy；不能猜本金、费用或分仓限额",
    );
  if (
    native &&
    account.candidates.some(
      (candidate) =>
        candidate.strategy.id.startsWith("l3-") && !candidate.sourceContext,
    )
  )
    throw new Error("L3纸面候选缺少同版本冻结sourceContext");
  if (account.candidates.some((c) => c.strategy.period !== period))
    throw new Error("合账候选须使用同一原生周期");
  if (account.market === "crypto") {
    const status = await publicDataStatus(
      publicDataRoot(config.binancePublicDataRoot),
    );
    const interval = period === "day" ? "1d" : period;
    if (!status.series.some((s) => s.interval === interval && s.manifest))
      throw new Error("纸面账户等待币安原生周期官方归档；请在系统中配置或回填");
  } else if (!config.tdxRoot) throw new Error("纸面账户等待通达信数据目录");
  const read = async (
    symbol: string,
    adjusted = false,
    requestedPeriod = period,
  ) => {
    const snapshot = await readBars({
      instrument: {
        market: account.market,
        symbol:
          account.market === "crypto" && !isCryptoSymbol(symbol)
            ? cryptoSymbol(symbol)
            : symbol,
      },
      period: requestedPeriod,
      adjustment:
        adjusted && account.market === "cn-equity" ? "forward" : "none",
      freezeRaw: adjusted,
      root: config.tdxRoot,
      cryptoSource: "binance",
      now,
      live: false,
      ...(native && account.market === "cn-equity"
        ? { source: "local" as const }
        : {}),
      to: account.market === "cn-equity" ? beijingClock(now).date : undefined,
    });
    const bars = snapshot.bars.filter(
      (b) =>
        !snapshot.barStore.formingDates.includes(b.date) &&
        (account.market === "crypto"
          ? cryptoPeriodEnd(b.date, requestedPeriod)
          : requestedPeriod === "day" || requestedPeriod === "week"
            ? Date.parse(`${b.date.slice(0, 10)}T15:00:00+08:00`)
            : Date.parse(b.date)) <= now,
    );
    const dates = new Set(bars.map((b) => b.date));
    const rawBars = (
      "rawBars" in snapshot ? (snapshot.rawBars as Bar[]) : bars
    ).filter((b) => dates.has(b.date));
    return {
      bars,
      rawBars,
      source: `${snapshot.source}/${snapshot.hash}/${snapshot.adjustment}`,
    };
  };
  const benchmark = await read(
    account.market === "crypto" ? "BTCUSDT" : "sh000906",
  );
  let calendar = benchmark.bars.map((b) => b.date);
  if (account.market === "cn-equity" && period === "day") {
    const reference = await localCalendarReference(
      config.tdxRoot,
      config.calendar,
    );
    calendar = [
      ...new Set([
        ...calendar,
        ...reference.days.filter(
          (d) => d >= calendar[0]! && paperCompletedAt(account, d) <= now,
        ),
      ]),
    ].sort();
  }
  const pending = calendar.filter(
    (d) =>
      d > (account.lastBar ?? "") &&
      (native
        ? paperCompletedAt(account, d) > account.startedAt
        : paperCompletedAt(account, d) >= account.startedAt),
  );
  const readyDates = account.market === "crypto" ? pending : [];
  if (account.market === "cn-equity")
    for (const date of pending) {
      // Historical accounting needs completed source bars, not a receipt that can no longer arrive.
      if (!benchmark.bars.some((b) => b.date === date)) break;
      if (date >= beijingClock(now).date && !(await downloadReady(date, now)))
        break;
      readyDates.push(date);
    }
  if (!readyDates.length) return null;
  if (
    native &&
    account.market === "cn-equity" &&
    account.candidates.every((candidate) =>
      candidate.strategy.id.startsWith("l3-"),
    ) &&
    dependencies.bookFacts === undefined &&
    dependencies.externalBySymbol === undefined &&
    dependencies.memberships === undefined &&
    dependencies.bookSeeds === undefined
  )
    return loadCnPaperContext(account, now, calendar, readyDates);
  const symbols = [
    ...new Set(
      account.candidates.flatMap((c) =>
        c.strategy.universe.kind === "symbols"
          ? c.strategy.universe.symbols
          : native
            ? (c.sourceContext?.universeSymbols ?? [])
            : [],
      ),
    ),
  ];
  if (!symbols.length) throw new Error("纸面候选缺少冻结证券池");
  const actions =
    account.market === "cn-equity"
      ? await corporateActions(config.tdxRoot)
      : null;
  const low = account.candidates.some(
    (c) => c.strategy.entry.kind === "historical-low",
  );
  const financials = low
    ? await readFinancialPoolHistory(config.tdxRoot, symbols, {
        asOf: beijingClock(now).date,
        strict: true,
        limit: 160,
        fieldIds: [96, 271],
      })
    : undefined;
  const instruments: PortfolioInstrument[] = [];
  const decisions: NonNullable<PaperInput["decisions"]> = [];
  const sources = [benchmark.source];
  const needsFixedPriceBasis = (kind: string | undefined) =>
    kind === "theory-screener" || kind === "study-rule";
  const hasPositionExit = account.candidates.some(({ strategy }) =>
    needsFixedPriceBasis(strategy.exit.rule?.kind),
  );
  const hasScreenerOrStudy =
    hasPositionExit ||
    account.candidates.some(({ strategy }) =>
      needsFixedPriceBasis(strategy.entry.kind),
    );
  const keepInitialWarmup = account.lastBar === null && hasScreenerOrStudy;
  const causalSignals = account.market === "cn-equity" && hasScreenerOrStudy;
  const checkpoint =
    causalSignals && (native || hasPositionExit) && account.lastBar
      ? new PaperRepository().state(account.id)
      : null;
  const firstReadyDate = readyDates[0]!;
  for (const symbol of symbols) {
    const data = await read(symbol, !causalSignals);
    const events = actions?.events.get(symbol) ?? [];
    // Later ex-rights events must not rescale a frozen signal stop or target.
    const causal =
      causalSignals && actions && events.length && data.rawBars.length
        ? causalResearchPrices(data.rawBars, events, actions.fingerprint, [])
        : null;
    let signalBars = causal?.bars ?? data.bars;
    // Existing legacy checkpoints may carry an earlier forward-adjusted scale.
    const frozen = checkpoint?.request.instruments
      .find((instrument) => instrument.symbol === symbol)
      ?.signalBars.at(-1);
    const anchor =
      frozen && frozen.date <= account.lastBar!
        ? signalBars.find((bar) => bar.date === frozen.date)
        : undefined;
    if (frozen && frozen.date <= account.lastBar! && !anchor)
      throw new Error("纸面检查点锚点行情缺失，无法对齐复权基准");
    const scale = frozen && anchor ? frozen.close / anchor.close : 1;
    if (!Number.isFinite(scale) || scale <= 0)
      throw new Error("纸面选股检查点复权基准无效");
    if (scale !== 1)
      signalBars = signalBars.map((bar) => ({
        ...bar,
        open: bar.open * scale,
        high: bar.high * scale,
        low: bar.low * scale,
        close: bar.close * scale,
      }));
    const signalSource = causal
      ? `${data.source}/${causal.proof.kind}/${causal.proof.seriesHash}/${scale}`
      : scale === 1
        ? data.source
        : `${data.source}/checkpoint-scale/${scale}`;
    sources.push(signalSource);
    const entitlements = actions
      ? researchCorporateActions(
          events,
          actions.fingerprint,
          calendar[0]!,
          calendar.at(-1)!,
        )
      : [];
    const external: StrategyExternalInputs = {
      ...dependencies.externalBySymbol?.[symbol],
    };
    if (low)
      external.lowZone = (
        await captureLowZoneFinancials(
          config.tdxRoot,
          symbol,
          signalBars.map((b) => b.date),
          financials,
        )
      ).facts;
    const instrument: PortfolioInstrument = {
      symbol,
      market: account.market,
      bars: data.rawBars,
      signalBars,
      external,
      actions: entitlements,
      execution:
        account.market === "cn-equity"
          ? Object.fromEntries(
              data.rawBars.flatMap((b, i) =>
                readyDates.includes(b.date)
                  ? [
                      [
                        b.date,
                        researchExecutionAt(
                          symbol,
                          b,
                          data.rawBars[i - 1],
                          entitlements,
                        )!,
                      ],
                    ]
                  : [],
              ),
            )
          : {
              evidence:
                "R2a-5 frozen paper research grid; not certified venue filters",
              minimum: 0.000001,
              step: 0.000001,
              limitUp: null,
              limitDown: null,
              tradable: true,
            },
    };
    if (account.market === "cn-equity" && !native) {
      decisions.push(
        ...capturePaperDecisions(
          account.candidates.map((c) => c.strategy),
          instrument,
          readyDates,
          now,
          signalSource,
        ),
      );
      const accepted = new Set(readyDates);
      // Replay needs the same signal history used to compute the first frozen stop.
      const acceptBar = (bar: Bar) =>
        accepted.has(bar.date) ||
        (keepInitialWarmup && bar.date < firstReadyDate);
      instrument.bars = instrument.bars.filter(acceptBar);
      instrument.signalBars = instrument.signalBars.filter(acceptBar);
      instrument.external = {};
    }
    instruments.push(instrument);
  }
  let request: PortfolioRequest = {
    market: account.market,
    initial: account.initial,
    start: native ? readyDates[0]! : calendar[0]!.slice(0, 10),
    end: native ? readyDates.at(-1)! : calendar.at(-1)!.slice(0, 10),
    calendar,
    instruments,
    strategies: account.candidates.map((c) => c.strategy),
    sleeves: policy?.sleeves ?? [
      paperSleevePolicy(account.market, account.sleeve, symbols.length),
    ],
    ...(policy ? { costs: policy.costs } : {}),
  };
  if (native) {
    const facts: Record<
      string,
      NonNullable<PortfolioRequest["bookFacts"]>[string]
    > = {};
    for (const { strategy } of account.candidates) {
      const supplied = dependencies.bookFacts?.[strategy.id] ?? {};
      const current = { ...supplied };
      if (strategy.regime && !current.benchmark) {
        const dailyBenchmark =
          (account.market === "crypto" && period === "4h") ||
          strategy.regime.benchmark !==
            (account.market === "crypto" ? "BTCUSDT" : "sh000906")
            ? await read(
                strategy.regime.benchmark,
                false,
                account.market === "crypto" && period === "4h" ? "day" : period,
              )
            : benchmark;
        sources.push(dailyBenchmark.source);
        current.benchmark = {
          symbol: strategy.regime.benchmark,
          bars: dailyBenchmark.bars,
        };
      }
      if (strategy.costFilter && current.roundTripCost === undefined) {
        const costs = policy!.costs!;
        if (costs.minimumCommission > 0)
          throw new Error("组合成本门控缺少冻结的最小佣金/名义金额成本依据");
        current.roundTripCost =
          (2 * costs.commissionBps + 2 * costs.slippageBps + costs.sellTaxBps) /
          10000;
      }
      if (
        strategy.rank?.kind === "rps-composite" &&
        instruments.some((i) => !i.external?.rps?.length)
      )
        throw new Error(
          "L3纸面rank缺少同一冻结证券池的完整RPS事实，不复用全市场排名",
        );
      if (strategy.rank?.kind === "classic" && !current.classicWeeks?.length)
        throw new Error("L3纸面classic缺少同版本、当时可见的完整截面事实");
      if (
        account.market === "cn-equity" &&
        (strategy.overlay?.industryWeight !== undefined ||
          strategy.overlay?.correlationGroupRisk !== undefined) &&
        !current.industries?.length
      )
        throw new Error("L3纸面组合缺少带来源的完整行业组事实");
      if (
        strategy.entry.kind === "external" &&
        strategy.entry.id === "l3-market-low-zone" &&
        !current.marketLowZone?.length
      )
        throw new Error("L3纸面低位缺少市场价格/广度/时点估值证据");
      facts[strategy.id] = current;
    }
    const memberships =
      dependencies.memberships ??
      account.candidates.flatMap(({ strategy, sourceContext }) => {
        if (
          strategy.universe.kind === "symbols" ||
          strategy.universe.kind === "rps"
        )
          return [];
        if (!sourceContext?.universeSymbols.length)
          throw new Error("L3纸面候选缺少带来源的冻结证券池");
        return calendar.map((date) => ({
          strategyId: strategy.id,
          date,
          availableAt: date,
          symbols: sourceContext.universeSymbols,
        }));
      });
    request = {
      ...request,
      bookFacts: facts,
      memberships,
      ...(dependencies.bookSeeds ? { bookSeeds: dependencies.bookSeeds } : {}),
    };
  }
  if (account.market === "crypto" && !native) {
    const weights = account.candidates.flatMap((c) => {
      if (c.registration.sizing === "legacy") return [];
      return (
        sizeCryptoResearch(
          { ...request, strategies: [c.strategy] },
          c.registration.sizing,
        ).positionWeights ?? []
      );
    });
    // Equal candidates have static1/N sizing; a volatility row's absence forbids entry.
    if (
      account.candidates.some((c) => c.registration.sizing === "volatility")
    ) {
      for (const c of account.candidates.filter(
        (c) => c.registration.sizing !== "volatility",
      ))
        for (const date of calendar)
          for (const symbol of symbols)
            weights.push({
              strategyId: c.strategy.id,
              symbol,
              date,
              availableAt: date,
              weight: 1 / symbols.length,
            });
      request = { ...request, positionWeights: weights };
    }
  }
  return {
    request,
    benchmark: benchmark.rawBars,
    readyDates,
    ...(account.market === "cn-equity" && !native ? { decisions } : {}),
    source: `BarStore ${account.market}; sources SHA256 ${createHash("sha256").update(JSON.stringify(sources)).digest("hex")}`,
  };
}
