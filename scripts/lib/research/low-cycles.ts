import { task, json, readArtifact, delivery } from "./context";
import { mainEquity } from "./main-inputs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  researchCandidates,
  historicalLowSeries,
  lowZoneCycles,
} from "trading-strategies";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  projectCandidate,
  numericNeighbors,
  scoreValidationResult,
} from "../../../src/server/research/validation-replay";
const { dataset, base } = await mainEquity(false);
const observations = historicalLowSeries(dataset.benchmark),
  cycles = lowZoneCycles(observations).filter(
    (c) => c.start >= dataset.dates[0]!,
  );
const cache = new Map(),
  rows = [];
for (const candidate of researchCandidates(
  dataset.instruments.map((i) => i.symbol),
  "cn-equity",
)
  .filter((c) => c.family === "historical-low")
  .flatMap((c) => [c, ...numericNeighbors(c)])) {
  const projected = projectCandidate(candidate, dataset, base, cache)!;
  const evaluations = cycles.map((c) => {
    const score = (cost = 1, delay: 0 | 1 = 0) => {
      const costs = marketRules["cn-equity"].costs!;
      const request: PortfolioRequest = {
        ...projected.request,
        observationDetail: "counts",
        start: c.start,
        end: c.end,
        signalDelayBars: delay,
        costs: Object.fromEntries(
          Object.entries(costs).map(([k, v]) => [
            k,
            typeof v === "number" ? v * cost : v,
          ]),
        ) as typeof costs,
      };
      return scoreValidationResult(runPortfolio(request), request, dataset);
    };
    return { ...c, base: score(), doubledCost: score(2), delayed: score(1, 1) };
  });
  rows.push({ id: candidate.strategy.id, cycles: evaluations });
  console.log(
    JSON.stringify({
      phase: "cycle-evaluated",
      id: candidate.strategy.id,
      cycles: evaluations.length,
      at: new Date().toISOString(),
    }),
  );
}
const diagnostics = [
  ["2012-01-01", "2014-12-31"],
  ["2016-01-01", "2016-12-31"],
  ["2018-01-01", "2019-12-31"],
].map(([start, end]) => {
  const points = observations
    .filter((o) => o.date >= start! && o.date <= end! && o.price.value !== null)
    .sort((a, b) => a.price.value! - b.price.value!);
  return {
    start,
    end,
    min: points[0],
    triggerDays: points.filter((o) => o.depth !== null && o.depth > 0).length,
  };
});
const path = join(task, "low-market-cycles.json");
await writeFile(
  path,
  JSON.stringify(
    {
      index: "sh000906",
      sourceStart: dataset.benchmark[0]!.date,
      cycles,
      diagnostics,
      rows,
      boundary:
        "Cycle-specific independent initial capital;cash/fill rules unchanged;two cycles cannot satisfy minimum3;not an alternative tuned detector.",
    },
    null,
    2,
  ),
);
await delivery({
  lowZoneMarketCycles: {
    path,
    index: "sh000906",
    complete: cycles.filter((c) => c.complete).length,
    rows: rows.length,
    minimum: 3,
    inputConfidence: "price-only/approximate valuation;temperature missing",
  },
});
process.exit(0);
