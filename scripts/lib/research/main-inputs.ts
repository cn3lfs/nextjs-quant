import {
  task,
  json,
  readArtifact,
  equity,
  frozen,
  digest,
  prior,
  config,
} from "./context";
import { join } from "node:path";
import type { Bar } from "trading-strategy-core/bars";
import type { PortfolioInstrument } from "quant-backtest";
import {
  historicalLowSeries,
  type LowZoneFact,
  type LowZoneObservation,
} from "trading-strategies";
import type { ValidationDataset } from "../../../src/server/research/validation-capture";
import { readPublicData } from "../../../src/server/data-sources/binance/public-data-store";
export async function mainEquity(includeRps = true) {
  const csi = await readArtifact<{
    symbols: string[];
    benchmark: { bars: Bar[] };
  }>(await json(join(task, "csi800-pointer.json")));
  const result = await equity(csi.symbols, includeRps, true);
  result.dataset.benchmark = csi.benchmark.bars;
  result.dataset.benchmarkName = "CSI800000906 raw index, no dividends";
  if (config.batch === "R2a-5") {
    result.base.lowZones.push({
      symbol: "sh000906",
      observations: historicalLowSeries(csi.benchmark.bars),
    });
    return result;
  }
  const selected = new Set(csi.symbols),
    facts = new Map<string, LowZoneFact[]>();
  const low = await prior<{ shards: string[] }>("low-input");
  for (const shard of low.shards)
    for (const row of await prior<
      {
        symbol: string;
        facts: [string, number | null, number | null][];
        observations: LowZoneObservation[];
      }[]
    >(shard)) {
      if (!selected.has(row.symbol)) continue;
      facts.set(
        row.symbol,
        row.facts.map(([date, pe, pb]) => ({
          date,
          availableAt: date,
          pe,
          pb,
          temperature: null,
          confidence: "approximate",
          source:
            "Frozen R2a3 PIT filter, approximate revisions; temperature unavailable",
        })),
      );
      result.base.lowZones.push({
        symbol: row.symbol,
        observations: row.observations,
      });
    }
  for (const i of result.dataset.instruments)
    i.external = { ...i.external, lowZone: facts.get(i.symbol) ?? [] };
  result.base.lowZones.push({
    symbol: "sh000906",
    observations: historicalLowSeries(csi.benchmark.bars),
  });
  return result;
}
export async function mainCrypto(period: "day" | "4h" | "1h" | "15m") {
  const coverage = await json<{
    root: string;
    series: { symbol: string; interval: string; status: string }[];
  }>(join(task, "crypto-coverage.json"));
  const instruments: PortfolioInstrument[] = [],
    sources: ValidationDataset["sources"] = [];
  const interval = period === "day" ? "1d" : period;
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    if (
      coverage.series.find(
        (s) => s.symbol === symbol && s.interval === interval,
      )?.status !== "ready"
    )
      throw new Error("Missing official native archive");
    const view = await readPublicData(symbol, interval, {
      root: coverage.root,
      now: Date.parse(config.end) + 86400000,
    });
    const bars = view.rows.map((r) => r.bar);
    instruments.push({
      symbol: `cx${symbol}`,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        minimum: 0.000001,
        step: 0.000001,
        maximum: 1e9,
        tradable: true,
        limitUp: null,
        limitDown: null,
        evidence: "Frozen research grid; historical venue filters unverified",
      },
    });
    sources.push({
      symbol: `cx${symbol}`,
      hash: digest(JSON.stringify(view.files.map((f) => [f.path, f.sha256]))),
      adjustmentReference: null,
    });
  }
  const benchmark = [...instruments[0]!.bars];
  const dataset: ValidationDataset = {
    period,
    instruments,
    sources,
    benchmark,
    dates: [...new Set(benchmark.map((b) => b.date.slice(0, 10)))],
    benchmarkName: "BTC hold from each window first open, no benchmark fees",
  };
  return { dataset, base: frozen(dataset) };
}
