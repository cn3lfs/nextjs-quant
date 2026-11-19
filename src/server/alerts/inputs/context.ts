import { createHash } from "node:crypto";
import { type StrategyObjectInput } from "trading-strategies";
import { settings } from "../../infra/settings";
import { AlertRepository } from "../../db/alert-repository";
import { readBars } from "../../market/bar-store/read-bars";
import { beijingClock } from "~/lib/market/market-session";
import { cryptoSymbol, isCryptoSymbol } from "~/lib/market/crypto";
import { closeScanDeadline } from "~/lib/market/close-scan-window";
import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import {
  type AlertEvaluation,
  type AlertPhase,
  type AlertProposal,
} from "../engine";
import { type Period, type Bar } from "~/lib/domain";
import { recordRuntimeError } from "../../infra/runtime-errors";
import { createPaperContext } from "./paper-context";

export function systemWatch(
  id: string,
  market: "cn-equity" | "crypto",
  symbol: string,
  sleeve = "swing",
): StrategyObjectInput {
  return {
    id,
    version: 1,
    market,
    period: "5m",
    sleeve,
    universe: { kind: "symbols", symbols: [symbol] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  };
}
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
export function createAlertContext(
  phase: AlertPhase,
  now: number,
  repo: AlertRepository,
  closeDate?: string,
) {
  const config = settings();
  const market: "cn-equity" | "crypto" =
    phase === "crypto" ? "crypto" : "cn-equity";
  const today = closeDate ?? beijingClock(now).date;
  const validity = (period: Period, completedAt: number, bar: string) => {
    if (phase !== "close" && period !== "day" && period !== "week")
      return 5 * 60000;
    if (market === "crypto") return 12 * 3600000;
    // The engine accepts an inclusive age; the pre-open cutoff itself is closed.
    return Math.max(
      0,
      closeScanDeadline(bar.slice(0, 10), repo.records.days()) -
        completedAt -
        1,
    );
  };
  const result: AlertEvaluation = { proposals: [], states: [] };
  const paper = createPaperContext(repo);
  const cache = new Map<string, Awaited<ReturnType<typeof readBars>>>();
  const series = async (symbol: string, period: Period, adjusted = false) => {
    const key = `${symbol}:${period}:${adjusted}`;
    let data = cache.get(key);
    if (!data) {
      data = await readBars({
        instrument: {
          market,
          symbol:
            market === "crypto" && !isCryptoSymbol(symbol)
              ? cryptoSymbol(symbol)
              : symbol,
        },
        period,
        adjustment: adjusted && market === "cn-equity" ? "forward" : "none",
        freezeRaw: adjusted,
        root: config.tdxRoot,
        to: market === "cn-equity" && period === "day" ? today : undefined,
        now,
        live: phase !== "close",
        limit: market === "crypto" ? 3000 : undefined,
      });
      cache.set(key, data);
    }
    const gapId = `data-gap:${market}:${symbol}`;
    if (
      !result.states.some(
        (s) => s.id === gapId && !(s.value as { resolved?: boolean }).resolved,
      )
    )
      result.states.push({ id: gapId, value: { at: now, resolved: true } });
    const bars = data.bars.filter(
      (b) => !data.barStore.formingDates.includes(b.date),
    );
    const completedDates = new Set(bars.map((b) => b.date));
    const rawBars =
      "rawBars" in data
        ? (data.rawBars as Bar[]).filter((b) => completedDates.has(b.date))
        : bars;
    return {
      symbol,
      market,
      bars,
      rawBars,
      source: `${data.source} / ${data.adjustment} / ${data.hash}`,
      completedAt: (bar: string) =>
        market === "crypto"
          ? cryptoPeriodEnd(bar, period)
          : period === "day" || period === "week"
            ? Date.parse(`${bar.slice(0, 10)}T15:05:00+08:00`)
            : Date.parse(bar),
    };
  };
  const error = (symbol: string, error: unknown) => {
    recordRuntimeError("alert-engine", error);
    result.states = result.states.filter(
      (s) => s.id !== `data-gap:${market}:${symbol}`,
    );
    result.states.push({
      id: `data-gap:${market}:${symbol}`,
      value: { at: now, reason: "行情或策略所需证据不可用；未生成假信号" },
    });
  };
  const propose = (
    strategy: StrategyObjectInput,
    symbol: string,
    bar: string,
    type: AlertProposal["event"]["type"],
    price: number | null,
    reason: string,
    source: string,
    completedAt: number,
    rest: Partial<AlertProposal["event"]> = {},
  ) => {
    result.proposals.push({
      strategy,
      completedAt,
      windowMs: validity(strategy.period, completedAt, bar),
      event: {
        strategyId: strategy.id,
        version: strategy.version,
        market,
        symbol,
        bar,
        type,
        price,
        sleeve: strategy.sleeve,
        stop: null,
        target: null,
        reason,
        source,
        ...rest,
      },
    });
  };

  return {
    phase,
    now,
    repo,
    closeDate,
    config,
    market,
    today,
    result,
    series,
    error,
    validity,
    propose,
    ...paper,
  };
}
export type AlertInputContext = ReturnType<typeof createAlertContext>;
