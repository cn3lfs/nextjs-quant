import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import type { StrategyExternalInputs } from "trading-strategies";
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
import { capturePaperDecisions } from "./decisions";
import { localCalendarReference } from "../market/data-health";

export async function loadPaperInput(
  account: PaperAccount,
  now: number,
): Promise<PaperInput | null> {
  const config = settings();
  const period = account.candidates[0]!.strategy.period;
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
  const read = async (symbol: string, adjusted = false) => {
    const snapshot = await readBars({
      instrument: {
        market: account.market,
        symbol:
          account.market === "crypto" && !isCryptoSymbol(symbol)
            ? cryptoSymbol(symbol)
            : symbol,
      },
      period,
      adjustment:
        adjusted && account.market === "cn-equity" ? "forward" : "none",
      freezeRaw: adjusted,
      root: config.tdxRoot,
      cryptoSource: "binance",
      now,
      live: false,
      to: account.market === "cn-equity" ? beijingClock(now).date : undefined,
    });
    const bars = snapshot.bars.filter(
      (b) =>
        !snapshot.barStore.formingDates.includes(b.date) &&
        paperCompletedAt(account, b.date) <= now,
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
      paperCompletedAt(account, d) >= account.startedAt,
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
  const symbols = [
    ...new Set(
      account.candidates.flatMap((c) =>
        c.strategy.universe.kind === "symbols"
          ? c.strategy.universe.symbols
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
  for (const symbol of symbols) {
    const data = await read(symbol, true);
    sources.push(data.source);
    const entitlements = actions
      ? researchCorporateActions(
          actions.events.get(symbol) ?? [],
          actions.fingerprint,
          calendar[0]!,
          calendar.at(-1)!,
        )
      : [];
    const external: StrategyExternalInputs = {};
    if (low)
      external.lowZone = (
        await captureLowZoneFinancials(
          config.tdxRoot,
          symbol,
          data.bars.map((b) => b.date),
          financials,
        )
      ).facts;
    const instrument: PortfolioInstrument = {
      symbol,
      market: account.market,
      bars: data.rawBars,
      signalBars: data.bars,
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
    if (account.market === "cn-equity") {
      decisions.push(
        ...capturePaperDecisions(
          account.candidates.map((c) => c.strategy),
          instrument,
          readyDates,
          now,
          data.source,
        ),
      );
      const accepted = new Set(readyDates);
      instrument.bars = instrument.bars.filter((b) => accepted.has(b.date));
      instrument.signalBars = instrument.signalBars.filter((b) =>
        accepted.has(b.date),
      );
      instrument.external = {};
    }
    instruments.push(instrument);
  }
  let request: PortfolioRequest = {
    market: account.market,
    initial: account.initial,
    start: calendar[0]!.slice(0, 10),
    end: calendar.at(-1)!.slice(0, 10),
    calendar,
    instruments,
    strategies: account.candidates.map((c) => c.strategy),
    sleeves: [
      {
        id: account.sleeve,
        share: 1,
        riskPerTrade: account.sleeve === "low-zone" ? 0.1 : 0.02,
        maxPositions: account.market === "crypto" ? symbols.length : 10,
      },
    ],
  };
  if (account.market === "crypto") {
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
    ...(account.market === "cn-equity" ? { decisions } : {}),
    source: `BarStore ${account.market}; sources SHA256 ${createHash("sha256").update(JSON.stringify(sources)).digest("hex")}`,
  };
}
