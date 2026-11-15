import {
  task,
  json,
  artifact,
  delivery,
  digest,
  calculationIdentity,
} from "./lib/research-r2a4";
import { scoreBookSleeves } from "./lib/research-book-sleeves";
import { mainEquity, mainCrypto } from "./lib/research-r2a4-main-inputs";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { researchCandidates, lowZoneCycles } from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  runPortfolio,
  runValidationSuite,
  type PortfolioRequest,
  type ValidationScore,
} from "quant-backtest";
import {
  projectCandidate,
  projectToExecutionClock,
  scoreValidationResult,
} from "../src/server/research/validation-replay";
import type { CandidateCheckpoint } from "../src/server/research/validation-scale";

const mode = process.argv[2];
if (!["cn", "crypto"].includes(mode ?? "")) throw new Error("Pass cn|crypto");
const presets = await json<{ declaredAt: string }>(
  join(task, "book-presets.json"),
);
if (
  (await json<{ engineAudit: { status: string } }>(".codex-runs/delivery.json"))
    .engineAudit.status !== "passed"
)
  throw new Error("Engine audit gate");
const { dataset, base } =
  mode === "cn" ? await mainEquity() : await mainCrypto("15m");
const menu = researchCandidates(
  dataset.instruments.map((i) => i.symbol),
  base.input.market,
);
let primary: PortfolioRequest, secondary: PortfolioRequest;
if (mode === "cn") {
  primary = projectCandidate(
    menu.find((c) => c.family === "rps-multi" && c.variant === "atr")!,
    dataset,
    base,
    new Map(),
  )!.request;
  secondary = projectCandidate(
    menu.find((c) => c.family === "historical-low" && c.variant === "atr")!,
    dataset,
    base,
    new Map(),
  )!.request;
} else {
  const swing = await mainCrypto("4h"),
    breakout = await mainCrypto("1h");
  primary = projectToExecutionClock(
    projectCandidate(
      menu.find((c) => c.family === "dual-ma-4h" && c.variant === "atr")!,
      swing.dataset,
      swing.base,
      new Map(),
    )!.request,
    dataset,
    16,
  );
  secondary = projectToExecutionClock(
    projectCandidate(
      menu.find((c) => c.family === "range-1h" && c.variant === "atr")!,
      breakout.dataset,
      breakout.base,
      new Map(),
    )!.request,
    dataset,
    4,
  );
}
const instruments = primary.instruments.map((i) => {
  const other = secondary.instruments.find((x) => x.symbol === i.symbol)!;
  return {
    ...i,
    external: {
      ...i.external,
      signals: [
        ...(i.external?.signals ?? []),
        ...(other.external?.signals ?? []),
      ],
      levels: [
        ...(i.external?.levels ?? []),
        ...(other.external?.levels ?? []),
      ],
    },
  };
});
// The index identity is explicit; CSI800 must never be silently replaced by CSI300.
function dynamicTargets() {
  const state = new Map<string, number>(),
    targets: NonNullable<PortfolioRequest["sleeveTargets"]>[number][] = [];
  const events = base.lowZones
    .flatMap((l) => l.observations.map((o) => ({ ...o, symbol: l.symbol })))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol),
    );
  let cursor = 0;
  for (const date of primary.calendar) {
    while (events[cursor] && events[cursor]!.date <= date) {
      const e = events[cursor++]!;
      state.set(e.symbol, e.targetShare);
    }
    const share = Math.max(0, ...state.values());
    targets.push({
      date,
      availableAt: date,
      shares: { swing: 1 - share, "low-zone": share },
    });
  }
  return targets;
}
const allocations =
  mode === "cn"
    ? [
        { name: "dynamic-0-30-35-40", share: 1, dynamic: true },
        { name: "static-65-35", share: 0.65, dynamic: false },
      ]
    : [
        { name: "75-25", share: 0.75, dynamic: false },
        { name: "80-20", share: 0.8, dynamic: false },
        { name: "70-30", share: 0.7, dynamic: false },
      ];
const policy = {
  ...base.input.policy,
  holdoutStart: "2025-06-01",
  trainBars: Math.max(20, Math.floor(dataset.dates.length * 0.4)),
  testBars: Math.max(5, Math.floor(dataset.dates.length * 0.1)),
};
const identity = digest(
  JSON.stringify({
    build: await calculationIdentity(base.input.market),
    script: digest(await readFile("scripts/research-r2a4-books.ts")),
    loader: digest(await readFile("scripts/lib/research-r2a4-main-inputs.ts")),
    sleeveAccounting: digest(
      await readFile("scripts/lib/research-book-sleeves.ts"),
    ),
    presets,
    sources: dataset.sources,
    policy,
  }),
);
const checkpoints: CandidateCheckpoint[] = [],
  books: unknown[] = [];
for (const allocation of allocations) {
  console.log(
    JSON.stringify({
      phase: "book-start",
      mode,
      allocation: allocation.name,
      at: new Date().toISOString(),
    }),
  );
  const sleeves = [
    { ...primary.sleeves[0]!, share: allocation.share },
    { ...secondary.sleeves[0]!, share: 1 - allocation.share },
  ];
  const request: PortfolioRequest = {
    ...primary,
    instruments,
    strategies: [...primary.strategies, ...secondary.strategies],
    costs: marketRules[primary.market].costs!,
    sleeves,
    rebalance: { everyBars: 20, drift: 0.05 },
    ...(allocation.dynamic ? { sleeveTargets: dynamicTargets() } : {}),
  };
  const id = `book-${mode}-${allocation.name}`;
  const records = new Map<string, Map<string, ValidationScore>>();
  const key = (r: PortfolioRequest) =>
    JSON.stringify([r.start, r.end, r.costs, r.signalDelayBars ?? 0]);
  function scores(
    result: ReturnType<typeof runPortfolio>,
    r: PortfolioRequest,
  ) {
    const market = scoreValidationResult(result, r, dataset);
    const bySleeve = scoreBookSleeves(result, r, dataset);
    records.set(key(r), bySleeve);
    return market;
  }
  const started = performance.now();
  const suite = runValidationSuite(
    [{ id, family: `book-${mode}`, request }],
    dataset.dates,
    policy,
    scores,
  );
  const fullResult = runPortfolio(request),
    fullPeriod = scores(fullResult, request);
  const marketRow = suite.rows[0]!;
  checkpoints.push({
    row: marketRow,
    training: suite.selection.map((w) => ({
      start: w.trainStart,
      end: w.trainEnd,
      score: w.families[0]!.training,
    })),
    fullPeriod,
    elapsedMs: performance.now() - started,
  });
  const find = (
    start: string,
    end: string,
    cost = 1,
    delay = 0,
    sleeve: string,
  ) => {
    const matches = [...records].filter(([k]) => {
      const v = JSON.parse(k) as [
        string,
        string,
        Record<string, number> | null,
        number,
      ];
      return (
        v[0] === start &&
        v[1] === end &&
        v[3] === delay &&
        (cost === 1
          ? v[2]?.slippageBps === request.costs?.slippageBps
          : v[2]?.slippageBps === (request.costs?.slippageBps ?? 0) * 2)
      );
    });
    if (matches.length !== 1)
      throw new Error(
        `Ambiguous sleeve score ${start}/${end}/${cost}/${delay}`,
      );
    return matches[0]![1].get(sleeve)!;
  };
  for (const sleeve of sleeves) {
    const project = (w: typeof marketRow.holdout) => ({
      ...w,
      base: find(w.start, w.end, 1, 0, sleeve.id),
      doubledCost: find(w.start, w.end, 2, 0, sleeve.id),
      delayed: find(w.start, w.end, 1, 1, sleeve.id),
    });
    const windows = marketRow.windows.map(project);
    const training = suite.selection.map((w) => ({
      start: w.trainStart,
      end: w.trainEnd,
      score: find(w.trainStart, w.trainEnd, 1, 0, sleeve.id),
    }));
    checkpoints.push({
      row: {
        ...marketRow,
        id: `sleeve-${mode}-${allocation.name}-${sleeve.id}`,
        family: `sleeve-${mode}-${sleeve.id}`,
        inSample: find(
          dataset.dates[0]!,
          dataset.dates[policy.trainBars - 1]!,
          1,
          0,
          sleeve.id,
        ),
        holdout: project(marketRow.holdout),
        windows,
        closedTrades: windows.reduce((n, w) => n + w.base.trades, 0),
      },
      training,
      fullPeriod: records.get(key(request))!.get(sleeve.id)!,
      elapsedMs: performance.now() - started,
    });
  }
  const dailyA = records.get(key(request))!.get(sleeves[0]!.id)!.daily,
    dailyB = records.get(key(request))!.get(sleeves[1]!.id)!.daily;
  const pairs = dailyA.flatMap((a, i) =>
      a !== null && dailyB[i] != null ? [[a, dailyB[i]!] as const] : [],
    ),
    ma = pairs.reduce((n, p) => n + p[0], 0) / pairs.length,
    mb = pairs.reduce((n, p) => n + p[1], 0) / pairs.length;
  const denom = Math.sqrt(
    pairs.reduce((n, p) => n + (p[0] - ma) ** 2, 0) *
      pairs.reduce((n, p) => n + (p[1] - mb) ** 2, 0),
  );
  books.push({
    allocation,
    shares: sleeves,
    targetDistribution: request.sleeveTargets?.reduce<Record<string, number>>(
      (counts, t) => {
        const share = String(t.shares["low-zone"]);
        counts[share] = (counts[share] ?? 0) + 1;
        return counts;
      },
      {},
    ),
    correlation:
      denom > 0
        ? pairs.reduce((n, p) => n + (p[0] - ma) * (p[1] - mb), 0) / denom
        : null,
    overlapDays: pairs.length,
    transfers: fullResult.transfers,
    accounting:
      "Actual shared account, transfer-adjusted conditional sleeve TWR; inactive pre-funding days null; never standalone weighted averages",
  });
  const pointer = await artifact(`books-${mode}`, {
    identity,
    policy,
    checkpoints,
    books,
    marketCycles:
      mode === "cn"
        ? lowZoneCycles(
            base.lowZones.find((l) => l.symbol === "sh000906")!.observations,
          ).filter((c) => c.start >= request.start && c.end <= request.end)
        : [],
  });
  await writeFile(
    join(task, `books-${mode}-progress.json`),
    JSON.stringify(
      { identity, pointer, complete: books.length === allocations.length },
      null,
      2,
    ),
  );
  await delivery({ activeBooks: { mode, complete: books.length, pointer } });
  console.log(
    JSON.stringify({
      phase: "book-complete",
      mode,
      allocation: allocation.name,
      at: new Date().toISOString(),
    }),
  );
}
process.exit(0);
