import { resolve } from "node:path";
import {
  marketPoolQuerySchema,
  selectMarketPoolRows,
  type MarketPoolRow,
} from "~/lib/market/market-pool";
import { isRpsMarketSymbol, rpsExclusionLabels } from "~/lib/screening/rps";
import type { Coverage } from "~/lib/domain";
import { get, sqlite } from "../db";
import { settings } from "../infra/settings";
import { securityDirectory } from "./securities";
import { readMarketPool } from "./market-pool-files";
import { RpsStore } from "../screening/rps-store";
import { exchangeNames } from "./exchange-security-names";
import {
  latestRpsObservation,
  observationRanking,
} from "../screening/rps-observation";
import { fullDaySymbols } from "../data-sources/tdx/tdx-full-day-cache";

export async function marketPoolRows(input: unknown) {
  const query = marketPoolQuerySchema.parse(input);
  const config = settings();
  const source = query.pool
    ? await readMarketPool(
        config.industryBlocksRoot,
        query.pool,
        config.tdxRoot,
      )
    : null;
  const directory = await securityDirectory();
  const imported = new Set(fullDaySymbols());
  const coverage = get<Coverage>("coverage");
  const local = new Set(
    coverage && resolve(coverage.root) === resolve(config.tdxRoot)
      ? coverage.securities
          .filter((s) => s.period === "day")
          .map((s) => s.symbol)
      : [],
  );
  const store = new RpsStore(sqlite());
  const stored = store.latest();
  const candidate = latestRpsObservation(config.tdxRoot);
  const observation =
    candidate &&
    (!stored ||
      candidate.date > stored.date ||
      (candidate.date === stored.date &&
        candidate.createdAt > stored.createdAt))
      ? candidate
      : null;
  const latest = observation?.day ?? stored;
  const day =
    latest && resolve(latest.source.root) === resolve(config.tdxRoot)
      ? latest
      : null;
  const ranks = new Map(
    day
      ? (observation
          ? observationRanking(observation, query.period)
          : store.ranking(day.date, query.period)
        ).map((r) => [r.symbol, r])
      : [],
  );
  const reasons = new Map<string, string>();
  if (day)
    for (const [key, symbols] of Object.entries(day.excluded))
      for (const symbol of symbols)
        reasons.set(
          symbol,
          rpsExclusionLabels[key as keyof typeof rpsExclusionLabels],
        );
  const catalogSymbols =
    directory.currentSymbols ?? Object.keys(directory.entries);
  const catalog = new Set(catalogSymbols);
  const unmatchedLocalCount = [...local].filter(
    (symbol) => isRpsMarketSymbol(symbol) && !catalog.has(symbol),
  ).length;
  const members = source?.members ?? [
    ...new Set([...Object.keys(directory.entries), ...local, ...imported]),
  ];
  const rows: MarketPoolRow[] = members.map((symbol) => ({
    symbol,
    name:
      directory.entries[symbol]?.name ??
      exchangeNames.get(symbol)?.name ??
      "名称未核实",
    identity: exchangeNames.get(symbol) ?? null,
    localDay: local.has(symbol),
    fullDayCache: imported.has(symbol),
    value: ranks.get(symbol) ?? null,
    reason: ranks.has(symbol)
      ? null
      : !day
        ? "尚无当前数据源的RPS，请先计算"
        : (reasons.get(symbol) ?? "该周期数据不足或未覆盖"),
  }));
  return {
    query,
    source: source ? { ...source, members: undefined } : null,
    membershipCount: members.length,
    unmatchedLocalCount,
    excludedMarket: members.filter((s) => !isRpsMarketSymbol(s)).length,
    rps: day
      ? {
          date: day.date,
          mode: day.mode,
          count: day.counts[day.periods.indexOf(query.period)]!,
          inputHash: day.inputHash,
          observation: observation
            ? {
                phase: observation.phase,
                createdAt: observation.createdAt,
                baseline: observation.baseline,
                coverage: observation.coverage,
                reused: observation.reused.length,
                missing: observation.missing.length,
              }
            : null,
        }
      : null,
    rows: selectMarketPoolRows(rows, query),
  };
}

export async function marketPoolPage(input: unknown) {
  const { rows, query, ...metadata } = await marketPoolRows(input);
  const selected = rows.findIndex((row) => row.symbol === query.selected);
  const neighbor = (index: number) =>
    rows[index]
      ? { symbol: rows[index]!.symbol, page: Math.floor(index / 20) }
      : null;
  return {
    ...metadata,
    total: rows.length,
    previous: selected > 0 ? neighbor(selected - 1) : null,
    next: selected >= 0 ? neighbor(selected + 1) : null,
    rows: rows.slice(query.page * 20, (query.page + 1) * 20),
  };
}
