import { createHash } from "node:crypto";
import { isAStock } from "tstdx/local";
import { calculateRpsAtIndex, type RpsSecurity } from "quant-rps";
import {
  historicalLowSeries,
  researchCandidates,
  strategyBuildHash,
  type LowZoneFact,
} from "trading-strategies";
import type { PortfolioInstrument } from "quant-backtest";
import type { FormulaRpsPoint } from "trading-strategies/formula/tdx-formula";
import { readBars } from "../market/bar-store/read-bars";
import {
  BarResourceBudget,
  BarResourceBudgetError,
} from "../market/bar-store/resource-budget";
import {
  captureValidationUniverse,
  validationListingEnd,
  validationMembersAt,
  type ValidationMember,
} from "./validation-universe";
import { captureLowZoneFinancials } from "./validation-financials";
import { captureNativeChanObservations } from "../strategies/strategy-center-native";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "./corporate-actions";
import type { Bar } from "trading-strategy-core/bars";
import type {
  ValidationInput,
  ValidationTerminalCoverage,
} from "./validation-model";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";
import { validationBuildHash } from "./validation-identity";
import { cryptoSymbol, isCryptoSymbol, cryptoPair } from "~/lib/market/crypto";
import {
  readResearchCryptoWindow,
  readCachedResearchCryptoWindow,
} from "./validation-crypto-history";
import { readColumnCache } from "../market/bar-store/column-cache";
import { readFinancialPoolHistory } from "../data-sources/tdx/local-financial-files";
import { chinaDate } from "~/lib/market/security-trading-status";
import {
  causalResearchPrices,
  readResearchPriceActions,
  type CausalPriceProof,
} from "./causal-price-basis";

export const validationHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Period = ReturnType<
  typeof researchCandidates
>[number]["strategy"]["period"];
/** Intraday labels are candle ends; daily labels are candle opens. */
export function researchHistoryBefore(
  oldest: string,
  period: Period,
  from: string,
) {
  const opening =
    Date.parse(oldest) -
    (period === "day" ? 0 : (cryptoPeriodMs[period] ?? 86400000));
  return opening <= Date.parse(from)
    ? null
    : new Date(opening - 1).toISOString();
}
export type ValidationDataset = {
  period: Period;
  instruments: PortfolioInstrument[];
  benchmark: Bar[];
  dates: string[];
  benchmarkName: string;
  sources: {
    symbol: string;
    hash: string;
    adjustmentReference: string | null;
    causalPrice?: CausalPriceProof;
    causalPriceGap?: string;
    terminalCoverage?: ValidationTerminalCoverage;
  }[];
};

class CryptoHistoryPageLimitError extends Error {}

function validationTerminal(
  member: ValidationMember | undefined,
  end: string,
  lastBar: Bar,
  benchmarkDates: ReadonlySet<string>,
):
  | {
      coverage: ValidationTerminalCoverage;
      terminal?: PortfolioInstrument["terminal"];
    }
  | undefined {
  if (!member) return;
  const listingEndsOn = validationListingEnd(member);
  const notice = member.terminalStatus?.lastTrading;
  const lastTradingDate = notice?.date ?? null;
  if (
    (!listingEndsOn || listingEndsOn > end) &&
    (!lastTradingDate || lastTradingDate > end)
  )
    return;

  let gap: string | null = null;
  if (!notice) gap = "Independent final trading-date evidence unavailable";
  else if (
    notice.date !== lastBar.date ||
    !Number.isFinite(lastBar.close) ||
    lastBar.close <= 0 ||
    !Number.isFinite(lastBar.volume) ||
    lastBar.volume <= 0
  )
    gap = `Missing observed raw close on final trading date ${notice.date}`;
  else if (!benchmarkDates.has(notice.date))
    gap = `Replay calendar missing final trading date ${notice.date}`;
  else if (notice.publishedOn > notice.date)
    gap = `Final trading date ${notice.date} was disclosed after that session`;

  // The first unpriced day is a coverage boundary. It never asserts a trading date.
  const afterObserved = new Date(Date.parse(lastBar.date) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const unavailableFrom = gap
    ? (lastTradingDate ??
      (listingEndsOn && listingEndsOn < afterObserved
        ? listingEndsOn
        : afterObserved))
    : null;
  return {
    coverage: {
      listingEndsOn,
      lastTradingDate,
      lastObservedDate: lastBar.date,
      unavailableFrom,
      gap,
    },
    ...(notice && !gap
      ? {
          terminal: {
            date: notice.date,
            valuation: "last-close",
            evidence: `Final trading date ${notice.date} (${notice.source}; archive SHA256 ${member.terminalStatus!.evidenceHash}); listing ends ${listingEndsOn ?? "unknown"}; raw last-close sensitivity only`,
          },
        }
      : {}),
  };
}

export async function captureValidationInput(
  input: ValidationInput,
  root: string,
  progress: (n: number, phase: string) => void = () => {},
  signal?: AbortSignal,
) {
  // Only new captures choose the current method. Parsing old frozen artifacts
  // leaves their absent method absent, preserving their recorded semantics.
  if (input.policy.returnCriterion !== "risk-adjusted")
    throw new Error(
      "New lifecycle validation requires the declared risk-adjusted return criterion",
    );
  if (input.policy.method === "legacy")
    throw new Error(
      "Legacy validation is read-only; replay its frozen input instead",
    );
  input = {
    ...input,
    policy: {
      ...input.policy,
      method: "lifecycle-2",
      purpose: input.policy.purpose ?? "post-hoc",
      clusterCorrelation: input.policy.clusterCorrelation ?? 0.95,
      maximumPbo: input.policy.maximumPbo ?? 0.5,
    },
  };
  if (
    input.end >=
    (input.market === "cn-equity"
      ? chinaDate(Date.now())
      : new Date().toISOString().slice(0, 10))
  )
    throw new Error("Only completed historical dates are permitted");
  const universe =
    input.market === "cn-equity"
      ? await captureValidationUniverse(root, input.start, input.end)
      : null;
  const available = universe?.members
    .filter((m) => {
      const listingEnd = validationListingEnd(m);
      return (
        m.local &&
        (!m.listingDate || m.listingDate <= input.end) &&
        (!listingEnd || listingEnd > input.start)
      );
    })
    .map((m) => m.symbol) ?? [
    "cxBTCUSDT",
    "cxETHUSDT",
    "cxSOLUSDT",
    "cxBNBUSDT",
  ];
  const explicitSymbols = input.symbols?.map((s) =>
    input.market === "crypto" && !isCryptoSymbol(s) ? cryptoSymbol(s) : s,
  );
  const requested =
    explicitSymbols ??
    (universe
      ? [
          ...new Set([
            ...universe.members
              .filter((m) => {
                const listingEnd = validationListingEnd(m);
                return (
                  m.local &&
                  listingEnd &&
                  listingEnd > input.start &&
                  listingEnd <= input.end
                );
              })
              .map((m) => m.symbol),
            ...Array.from(
              { length: Math.min(input.sampleSize, available.length) },
              (_, i) =>
                available[
                  Math.floor(
                    (i * available.length) /
                      Math.min(input.sampleSize, available.length),
                  )
                ]!,
            ),
          ]),
        ].slice(0, input.sampleSize)
      : available);
  if (input.market === "cn-equity" && requested.some((s) => !isAStock(s)))
    throw new Error("Equity research requires stock symbols");
  if (new Set(requested).size !== requested.length)
    throw new Error("Research symbols must be unique");
  if (universe && explicitSymbols) {
    const members = new Set(universe.members.map(({ symbol }) => symbol));
    const absent = explicitSymbols.filter((symbol) => !members.has(symbol));
    if (absent.length)
      throw new Error(
        `Symbols absent from frozen local roster: ${absent.join(", ")}`,
      );
  }
  const excluded: { symbol: string; period: string; reason: string }[] = [];
  const gaps: string[] = [];
  const datasets: ValidationDataset[] = [];
  const native: {
    symbol: string;
    capture: Awaited<ReturnType<typeof captureNativeChanObservations>>;
  }[] = [];
  const financials: {
    symbol: string;
    capture: Awaited<ReturnType<typeof captureLowZoneFinancials>>;
  }[] = [];
  const lowZones: {
    symbol: string;
    observations: ReturnType<typeof historicalLowSeries>;
  }[] = [];
  const periods: Period[] =
    input.market === "cn-equity" ? ["day"] : ["day", "4h", "1h", "15m"];
  const budget = new BarResourceBudget();
  const readForTask: typeof readBars = (query) =>
    readBars(query, undefined, undefined, budget);
  const actions = universe ? await readResearchPriceActions(root) : null;
  const financialHistory = universe
    ? await readFinancialPoolHistory(root, requested, {
        asOf: input.end,
        strict: true,
        limit: 160,
        fieldIds: [96, 271],
        signal,
        progress: (done, total) =>
          progress(4, `冻结财务组成期 ${done}/${total}`),
      })
    : undefined;
  const rpsAudit: {
    date: string;
    pool: number;
    excluded: ReturnType<typeof calculateRpsAtIndex>["excluded"];
  }[] = [];
  for (const period of periods) {
    const instruments: PortfolioInstrument[] = [],
      sources: ValidationDataset["sources"] = [];
    const benchmarkSnapshot =
      input.market === "cn-equity"
        ? await readForTask({
            instrument: { market: "cn-equity", symbol: "sh000300" },
            root,
            period: "day",
            adjustment: "none",
            to: input.end,
          })
        : null;
    const benchmarkDates = new Set(
      benchmarkSnapshot?.bars.map((bar) => bar.date),
    );
    for (const [index, symbol] of requested.entries()) {
      signal?.throwIfAborted();
      progress(
        Math.round(
          5 +
            (30 * (periods.indexOf(period) + index / requested.length)) /
              periods.length,
        ),
        `冻结 ${symbol} ${period}`,
      );
      try {
        const from = input.market === "crypto" ? "1970-01-01" : undefined;
        const budgetContext = { symbol, period };
        const quarantine = new Map<string, Bar>();
        const read = async (to: string) => {
          const query = {
            instrument: { market: input.market, symbol },
            root,
            period,
            adjustment:
              input.market === "crypto"
                ? ("none" as const)
                : ("forward" as const),
            freezeRaw: true,
            to,
            ...(input.market === "crypto"
              ? { from, cryptoSource: input.cryptoSource }
              : {}),
          };
          if (input.market !== "crypto") return readForTask(query);
          const result = await readResearchCryptoWindow(query);
          budget.checkSource(
            result.snapshot.bars.length + result.quarantined.length,
            budgetContext,
          );
          for (const bar of result.quarantined) quarantine.set(bar.date, bar);
          return result.snapshot;
        };
        let snapshot = await read(input.end);
        if (input.market === "crypto") {
          // BarStore owns source/cache/pagination. Extend the same public venue
          // backwards in bounded windows, never splice prices from two venues.
          let oldest = snapshot.bars[0]?.date;
          for (let page = 0; oldest; page++) {
            signal?.throwIfAborted();
            const before = researchHistoryBefore(oldest, period, from!);
            if (!before) break;
            const base = period === "4h" ? "1h" : period;
            if (
              readColumnCache(`crypto:${symbol}:${base}:${input.cryptoSource}`)
                ?.metadata.source.historyExhausted === true
            )
              break;
            // BarStore limits source bars separately. This bounds pagination
            // even if a venue keeps returning progressively smaller pages.
            if (page >= 400)
              throw new CryptoHistoryPageLimitError(
                `Crypto history pagination limit exceeded [${symbol} ${period}, source]: ${page}/400 pages`,
              );
            let earlier: Awaited<ReturnType<typeof read>>;
            try {
              earlier = await read(before);
            } catch (error) {
              if (error instanceof BarResourceBudgetError) throw error;
              gaps.push(
                `${symbol}/${period} earlier history before ${oldest} unavailable: ${error instanceof Error ? error.message : "source unavailable"}`,
              );
              break;
            }
            const next = earlier.bars[0]?.date;
            if (!next || next >= oldest) break;
            oldest = next;
          }
          if (input.cryptoSource === "binance") {
            const cached = await readCachedResearchCryptoWindow({
              instrument: { market: "crypto", symbol },
              period,
              adjustment: "none",
              cryptoSource: "binance",
              from,
              to: input.end,
            });
            if (!cached)
              throw new Error(
                "Observed crypto cache disappeared before freeze",
              );
            snapshot = cached.snapshot;
            budget.checkSource(
              snapshot.bars.length + cached.quarantined.length,
              budgetContext,
            );
            for (const bar of cached.quarantined) quarantine.set(bar.date, bar);
          } else snapshot = await read(input.end);
        }
        for (const bar of quarantine.values())
          gaps.push(
            `${symbol}/${period} quarantined off-grid raw source bar: ${JSON.stringify(bar)}`,
          );
        const member = universe?.members.find((m) => m.symbol === symbol);
        const listingEnd = member ? validationListingEnd(member) : null;
        const lastTrading = member?.terminalStatus?.lastTrading?.date;
        if (listingEnd && listingEnd <= input.start)
          throw new Error(
            `Member already delisted at research start: ${listingEnd}`,
          );
        const completed = snapshot.bars.filter(
          (b) =>
            !snapshot.barStore.formingDates.includes(b.date) &&
            (!listingEnd || b.date < listingEnd) &&
            (!lastTrading || b.date <= lastTrading),
        );
        if (snapshot.sourceNote && input.market === "cn-equity")
          throw new Error(`Repaired/dropped source: ${snapshot.sourceNote}`);
        if (universe && !snapshot.rawBars)
          throw new Error("Missing unadjusted A-share execution prices");
        const rawByDate = new Map(
          (snapshot.rawBars ?? completed).map((b) => [b.date, b]),
        );
        const bars = completed.map((b) => rawByDate.get(b.date)!);
        if (!bars.length || bars.some((b) => !b))
          throw new Error("No aligned completed raw/signal bars");
        const events =
          actions?.events
            .get(symbol)
            ?.filter(
              (a) =>
                a.date >= input.start &&
                a.date <= input.end &&
                (!listingEnd || a.date < listingEnd) &&
                (!lastTrading || a.date <= lastTrading),
            ) ?? [];
        const terminal = validationTerminal(
          member,
          input.end,
          bars.at(-1)!,
          benchmarkDates,
        );
        if (terminal?.coverage.gap)
          gaps.push(
            `${symbol}/${period} terminal valuation unavailable: ${terminal.coverage.gap}`,
          );
        let signalBars = completed;
        let causalPrice: CausalPriceProof | undefined;
        let causalPriceGap: string | undefined;
        if (actions) {
          try {
            const causal = causalResearchPrices(
              bars,
              actions.events.get(symbol) ?? [],
              actions.sourceSha256,
              actions.issues,
            );
            signalBars = causal.bars;
            causalPrice = causal.proof;
          } catch (error) {
            causalPriceGap =
              error instanceof Error ? error.message : String(error);
          }
        }
        // Crypto pages are transient. Commit only the final frozen raw/signal
        // pair to the task budget after paging and quarantine have finished.
        if (input.market === "crypto")
          budget.retain(bars.length + signalBars.length, budgetContext);
        const entitlements = actions
          ? researchCorporateActions(
              events,
              actions.sourceSha256,
              input.start,
              input.end,
            )
          : [];
        const execution: PortfolioInstrument["execution"] =
          input.market === "crypto"
            ? {
                evidence:
                  "Research quantity grid 0.000001, not certified historical venue filters",
                minimum: 0.000001,
                step: 0.000001,
                maximum: 1e9,
                tradable: true,
                limitUp: null,
                limitDown: null,
              }
            : Object.fromEntries(
                bars.map((bar, index) => [
                  bar.date,
                  researchExecutionAt(
                    symbol,
                    bar,
                    bars[index - 1],
                    entitlements,
                  )!,
                ]),
              );
        let lowZone: LowZoneFact[] = [];
        if (input.market === "cn-equity") {
          try {
            const capture = await captureLowZoneFinancials(
              root,
              symbol,
              completed.map((b) => b.date),
              financialHistory,
            );
            financials.push({ symbol, capture });
            lowZone = capture.facts;
          } catch (error) {
            gaps.push(
              `${symbol} financials: ${error instanceof Error ? error.message : "unavailable"}`,
            );
          }
          lowZones.push({
            symbol,
            observations: historicalLowSeries(signalBars, {}, lowZone),
          });
        }
        instruments.push({
          symbol,
          market: input.market,
          bars,
          signalBars,
          execution,
          external: { lowZone },
          actions: entitlements,
          ...(terminal?.terminal ? { terminal: terminal.terminal } : {}),
        });
        sources.push({
          symbol,
          hash: snapshot.hash,
          adjustmentReference:
            causalPrice?.kind ?? snapshot.barStore.adjustmentReference,
          ...(causalPrice ? { causalPrice } : {}),
          ...(causalPriceGap ? { causalPriceGap } : {}),
          ...(terminal ? { terminalCoverage: terminal.coverage } : {}),
        });
      } catch (error) {
        if (
          error instanceof BarResourceBudgetError ||
          error instanceof CryptoHistoryPageLimitError
        )
          throw error;
        excluded.push({
          symbol,
          period,
          reason: error instanceof Error ? error.message : "Source unavailable",
        });
      }
    }
    if (instruments.length < 2) {
      gaps.push(`${period}: fewer than two usable instruments`);
      continue;
    }
    const benchmark =
      benchmarkSnapshot?.bars ??
      instruments.find((i) => cryptoPair(i.symbol) === "BTCUSDT")?.bars;
    if (!benchmark) {
      gaps.push(`${period}: BTC benchmark unavailable; dataset not published`);
      continue;
    }
    const dates = [
      ...new Set(
        benchmark
          .map((b) => b.date.slice(0, 10))
          .filter((d) => d >= input.start && d <= input.end),
      ),
    ];
    if (dates.length < 30) {
      gaps.push(`${period}: fewer than 30 observed days`);
      continue;
    }
    if (universe) {
      const rpsPeriods = [20, 50, 120];
      const adjusted = [];
      for (const i of instruments) {
        adjusted.push(
          await readForTask({
            instrument: { market: "cn-equity", symbol: i.symbol },
            root,
            period: "day",
            adjustment: "backward",
            to: sources.find((source) => source.symbol === i.symbol)
              ?.terminalCoverage
              ? i.bars.at(-1)!.date
              : input.end,
          }),
        );
      }
      const bySymbol = new Map(
        adjusted.map((s) => [
          s.symbol,
          new Map(s.bars.map((b) => [b.date, b])),
        ]),
      );
      const calendar = benchmark.map((b) => b.date);
      const rpsStocks: RpsSecurity[] = adjusted.map((s) => ({
        symbol: s.symbol,
        name:
          universe.members.find((m) => m.symbol === s.symbol)?.name ?? s.symbol,
        firstDate: s.bars[0]!.date,
        closes: bySymbol.get(s.symbol)!,
        unsupportedDates: (actions?.events.get(s.symbol) ?? [])
          .filter((e) => [11, 12, 13, 14].includes(e.category))
          .map((e) => e.date),
      }));
      const points = new Map<string, FormulaRpsPoint[]>(
        instruments.map((i) => [i.symbol, []]),
      );
      const rpsRoster = {
        members: universe.members.filter((member) =>
          bySymbol.has(member.symbol),
        ),
      };
      for (const [dayIndex, date] of calendar.entries()) {
        const members = new Set(validationMembersAt(rpsRoster, date));
        const ranked =
          dayIndex < 120
            ? null
            : calculateRpsAtIndex(
                rpsStocks.filter((s) => members.has(s.symbol)),
                calendar,
                dayIndex,
                rpsPeriods,
                date,
              );
        if (ranked)
          rpsAudit.push({ date, pool: ranked.pool, excluded: ranked.excluded });
        const ranks = new Map(
          ranked?.rows.map((row) => [row.symbol, row.values]),
        );
        for (const instrument of instruments)
          points.get(instrument.symbol)!.push({
            date,
            periods: rpsPeriods,
            values: ranks.get(instrument.symbol) ?? rpsPeriods.map(() => null),
          });
      }
      for (const instrument of instruments)
        instrument.external = {
          ...instrument.external,
          rps: points.get(instrument.symbol)!,
        };
      const indexLow = historicalLowSeries(benchmark);
      lowZones.push({ symbol: "sh000300", observations: indexLow });
      // One serial DLL owner, fixed 140-bar origin. Bounded native subset is
      // selected by symbol order before seeing any strategy outcomes.
      for (const instrument of instruments.slice(0, 2)) {
        const first = instrument.bars.findIndex((b) => b.date >= dates[0]!);
        if (first < 140) {
          gaps.push(`${instrument.symbol}: native warmup unavailable`);
          continue;
        }
        const nativeBars = instrument.signalBars.slice(first - 140);
        try {
          const capture = await captureNativeChanObservations(
            nativeBars,
            140,
            signal,
          );
          native.push({ symbol: instrument.symbol, capture });
        } catch (error) {
          gaps.push(
            `${instrument.symbol} native: ${error instanceof Error ? error.message : "unavailable"}`,
          );
        }
      }
    }
    datasets.push({
      period,
      instruments,
      benchmark: [...benchmark],
      dates,
      sources,
      benchmarkName:
        input.market === "cn-equity"
          ? "沪深300价格指数（不含股息）；首日开盘持有"
          : `BTCUSDT ${input.cryptoSource} 持有（无费用，首日开盘）`,
    });
  }
  return {
    version: "research-validation-input-1" as const,
    timingContract: "p5" as const,
    input,
    root,
    strategyBuildHash,
    validationBuildHash: validationBuildHash(),
    evidence: {
      universeComplete: false,
      executionVerified: false,
      firstVintageFinancials: false,
    },
    universe,
    datasets,
    native,
    financials,
    lowZones,
    rpsAudit,
    excluded,
    gaps,
    selection:
      "Declared symbols or evenly spaced sorted local roster, delisted cached names first; native first two usable symbols. Chosen before outcomes, not a representative full-market claim",
    candidateMenu: researchCandidates(
      datasets[0]?.instruments.map((i) => i.symbol) ?? requested,
      input.market,
    ),
  };
}
export type FrozenValidationInput = Omit<
  Awaited<ReturnType<typeof captureValidationInput>>,
  "timingContract" | "universe"
> & {
  timingContract?: "p5";
  universe: import("./validation-universe").ValidationUniverse | null;
};
