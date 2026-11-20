import { isRpsMarketSymbol, rpsExclusionLabels, type RpsRow } from "quant-rps";
import { resolve } from "node:path";
import {
  marketPoolQuerySchema,
  selectMarketPoolRows,
  type MarketPoolRow,
  type MarketPoolAvailability,
} from "~/lib/market/market-pool";

import type { Coverage } from "~/lib/domain";
import { get, sqlite } from "../db";
import { settings } from "../infra/settings";
import { securityDirectory } from "./securities";
import { readMarketPool } from "./market-pool-files";
import { RpsStore } from "../db/rps-store";
import { exchangeNames } from "./exchange-security-names";
import { latestRpsObservation } from "../db/rps-observations";
import { fullDaySymbols } from "~/server/market/bar-store/package-import";

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
  const currentCoverage =
    coverage && resolve(coverage.root) === resolve(config.tdxRoot)
      ? coverage
      : null;
  const local = new Set(
    currentCoverage
      ? currentCoverage.securities
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
  const vectors = new Map<string, RpsRow["values"]>();
  if (day) {
    const sourceRows = observation ? observation.rows : store.rows(day.date);
    for (const row of sourceRows) vectors.set(row.symbol, row.values);
  }
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
  const rows: MarketPoolRow[] = members.map((symbol) => {
    const vector = vectors.get(symbol);
    const rpsValues = Object.fromEntries(
      (day?.periods ?? []).map((period, index) => [
        period,
        vector?.[index] ?? null,
      ]),
    );
    const value = rpsValues[query.period] ?? null;
    return {
      symbol,
      name:
        directory.entries[symbol]?.name ??
        exchangeNames.get(symbol)?.name ??
        "名称未核实",
      identity: exchangeNames.get(symbol) ?? null,
      localDay: local.has(symbol),
      fullDayCache: imported.has(symbol),
      // Queries without RPS conditions historically include the symbol in value.
      value:
        value && query.conditions.length === 0 ? { symbol, ...value } : value,
      rpsValues,
      ...(query.conditions.length
        ? {
            conditionValues: Object.fromEntries(
              query.conditions.map(({ period }) => [
                period,
                rpsValues[period] ?? null,
              ]),
            ),
          }
        : {}),
      reason: value
        ? null
        : !day
          ? "尚无当前数据源的RPS，请先计算"
          : !day.periods.includes(query.period)
            ? "该历史批次未计算此周期，等待新批次"
            : (reasons.get(symbol) ?? "该周期数据不足或未覆盖"),
    };
  });
  return {
    query,
    availability: {
      rps: !day
        ? "missing"
        : day.periods.includes(query.period)
          ? "ready"
          : "period-missing",
      dailyIndex: !currentCoverage
        ? "not-scanned"
        : local.size
          ? "ready"
          : "empty",
    } satisfies MarketPoolAvailability,
    source: source ? { ...source, members: undefined } : null,
    membershipCount: members.length,
    unmatchedLocalCount,
    excludedMarket: members.filter((s) => !isRpsMarketSymbol(s)).length,
    rps: day
      ? {
          date: day.date,
          mode: day.mode,
          count: day.counts[day.periods.indexOf(query.period)] ?? null,
          inputHash: day.inputHash,
          ...(query.conditions.length
            ? {
                conditions: query.conditions.map((condition) => {
                  const index = day.periods.indexOf(condition.period);
                  return {
                    ...condition,
                    count: index < 0 ? null : (day.counts[index] ?? null),
                    periodMissing: index < 0,
                  };
                }),
              }
            : {}),
          observation: observation
            ? {
                phase: observation.phase,
                createdAt: observation.createdAt,
                baseline: observation.baseline,
                coverage: observation.coverage,
                reused: observation.reused.length,
                missing: observation.missing.length,
                // A close observation is only a confirmed persistent close when
                // the same day was written to the RPS store.
                persistedClose:
                  observation.phase === "close" &&
                  stored?.date === observation.day.date,
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
    period: query.period,
    total: rows.length,
    previous: selected > 0 ? neighbor(selected - 1) : null,
    next: selected >= 0 ? neighbor(selected + 1) : null,
    rows: rows.slice(query.page * 20, (query.page + 1) * 20),
  };
}
