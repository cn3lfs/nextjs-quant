import {
  task,
  json,
  prior,
  artifact,
  readArtifact,
  digest,
  delivery,
} from "./lib/research-r2a4";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  validationDefaults,
  validationRowReasons,
  validationScorePasses,
  type ValidationScore,
  type ValidationPolicy,
} from "quant-backtest";
import {
  multipleTesting,
  sharpeDaily,
  sharpeVariance,
  deflatedSharpeThreshold,
} from "../src/lib/backtest/multiple-testing";
import type { CandidateCheckpoint } from "../src/server/research/validation-scale";
import { strategyBuildHash } from "trading-strategies";
import { saveValidationScoreboard } from "../src/server/db/validation-scoreboard";
import { StrategyRepository } from "../src/server/db/strategy-repository";
import { atomic } from "../src/server/db";
import { researchCandidates } from "trading-strategies";
import { numericNeighbors } from "../src/server/research/validation-replay";
import type { ScoreboardRow } from "../src/server/research/validation-model";

type Group = {
  scope: string;
  family: string;
  policy?: ValidationPolicy;
  checkpoints: CandidateCheckpoint[];
  symbols?: string[];
  marketCycles?: { complete: boolean }[];
};
type Located = { scope: string; group: Group; checkpoint: CandidateCheckpoint };
const audit = await json<{
  engineAudit: { status: string };
  breakout15mAttribution: {
    status: string;
    btcEth: { differences: number; independentSamples: number };
  };
}>(".codex-runs/delivery.json");
if (
  audit.engineAudit.status !== "passed" ||
  audit.breakout15mAttribution.status !== "both-audited" ||
  audit.breakout15mAttribution.btcEth.differences !== 0 ||
  audit.breakout15mAttribution.btcEth.independentSamples < 20
)
  throw new Error("Execution audit gate must pass before publishing");
const cn = [
  "rps-multi",
  "double-breakout",
  "formula-ma",
  "formula-range",
  "formula-pullback",
  "historical-low",
  "chan-third-buy",
];
const cx = [
  "dual-ma-day",
  "range-day",
  "dual-ma-4h",
  "range-4h",
  "range-1h",
  "range-15m",
];
const locations: Located[] = [],
  pointers: unknown[] = [];
for (const [scope, families] of [
  ["csi800", cn],
  ["btc-eth", cx],
] as const)
  for (const family of families) {
    const p = await json<{
      complete: boolean;
      pointer: { path: string; sha256: string };
    }>(join(task, `${scope}-${family}-progress.json`));
    if (!p.complete) throw new Error(`Incomplete main ${scope}/${family}`);
    const group = await readArtifact<Group>(p.pointer);
    if (group.checkpoints.length !== 9)
      throw new Error("Nine unchanged variants required");
    pointers.push(p.pointer);
    locations.push(
      ...group.checkpoints.map((checkpoint) => ({ scope, group, checkpoint })),
    );
  }
for (const family of [...cn.filter((f) => f !== "chan-third-buy"), ...cx]) {
  const group = await prior<Group>(
    `candidate-${cx.includes(family) ? "crypto" : family === "historical-low" ? "cnlowzone" : "cnswing"}-${family}`,
  );
  locations.push(
    ...group.checkpoints.map((checkpoint) => ({
      scope: cx.includes(family) ? "prior20" : "prior1638",
      group,
      checkpoint,
    })),
  );
}
const broad = await json<{
  complete: boolean;
  pointer: { path: string; sha256: string };
}>(join(task, "all-market-native-progress.json"));
if (!broad.complete) throw new Error("Broad native study incomplete");
const broadGroup = await readArtifact<Group>(broad.pointer);
locations.push(
  ...broadGroup.checkpoints.map((checkpoint) => ({
    scope: "prior-native-prefix",
    group: broadGroup,
    checkpoint,
  })),
);
pointers.push(broad.pointer);
for (const mode of ["cn", "crypto"]) {
  const p = await json<{
    complete: boolean;
    pointer: { path: string; sha256: string };
  }>(join(task, `books-${mode}-progress.json`));
  if (!p.complete) throw new Error("Book incomplete");
  const group = await readArtifact<Group>(p.pointer);
  group.family = `book-${mode}`;
  locations.push(
    ...group.checkpoints.map((checkpoint) => ({
      scope: `books-${mode}`,
      group,
      checkpoint,
    })),
  );
  pointers.push(p.pointer);
}
type Sensitivity = {
  id: string;
  exclude: { full: ValidationScore; holdout: ValidationScore };
  outcomes: {
    valuation: string;
    full: ValidationScore;
    holdout: ValidationScore;
    terminalValuations: unknown[];
  }[];
};
const sensitivity: Sensitivity[] = [];
for (const family of cn.filter((f) => f !== "chan-third-buy")) {
  const p = await json<{
    complete: boolean;
    pointer: { path: string; sha256: string };
  }>(join(task, `all-market-sensitivity-${family}-progress.json`));
  if (!p.complete) throw new Error("Sensitivity incomplete");
  const group = await readArtifact<{ sensitivity: Sensitivity[] }>(p.pointer);
  if (group.sensitivity.length !== 9)
    throw new Error("Missing sensitivity variants");
  sensitivity.push(...group.sensitivity);
  pointers.push(p.pointer);
}
const trials = locations.map((l) => ({
  id: `${l.scope}|${l.checkpoint.row.id}`,
  sharpe: sharpeDaily(
    l.checkpoint.row.id.startsWith("sleeve-")
      ? l.checkpoint.fullPeriod.daily.filter((v): v is number => v !== null)
      : l.checkpoint.fullPeriod.daily,
  ),
}));
for (const s of sensitivity)
  for (const o of s.outcomes)
    trials.push({
      id: `terminal-${o.valuation}|${s.id}`,
      sharpe: sharpeDaily(o.full.daily),
    });
// Original descriptive books are real attempted allocations, included in the
// common denominator even though they have no independent OOS qualification.
const comparisonBooks: unknown[] = [];
for (const name of ["crypto-books", "equity-books"]) {
  try {
    const doc = await prior<{
      boundary: string;
      variants: {
        name: string;
        shares: Record<string, number>;
        correlation: number | null;
        overlapDays: number;
        score: ValidationScore;
        sleeveScores: {
          sleeve: string;
          daily: (number | null)[];
          observed: number;
          return: number | null;
          drawdown: number | null;
        }[];
      }[];
    }>(name);
    for (const v of doc.variants) {
      trials.push({
        id: `prior-book-${name}-${v.name}`,
        sharpe: sharpeDaily(v.score.daily),
      });
      for (const s of v.sleeveScores)
        trials.push({
          id: `prior-sleeve-${name}-${v.name}-${s.sleeve}`,
          sharpe: sharpeDaily(s.daily.filter((v): v is number => v !== null)),
        });
    }
    comparisonBooks.push({
      scope: name === "crypto-books" ? "prior20" : "prior1638",
      boundary: doc.boundary,
      variants: doc.variants.map((v) => {
        const { daily, ...score } = v.score;
        return {
          name: v.name,
          shares: v.shares,
          correlation: v.correlation,
          overlapDays: v.overlapDays,
          score,
          sleeves: v.sleeveScores.map(({ daily, ...s }) => s),
          newPassed: false,
          oldPassed: false,
          reasons: [
            "descriptive-full-period-book-not-independent-oos",
            "holdout-and-stress-evidence-missing",
          ],
        };
      }),
    });
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("Missing predecessor")))
      throw e;
  }
}
if (new Set(trials.map((t) => t.id)).size !== trials.length)
  throw new Error("Duplicate statistical trial identities");
const trialSharpes = trials.map((t) => t.sharpe);
const trialVariance = sharpeVariance(trialSharpes.map((t) => t.value));
const familyThreshold =
  trialVariance.value === null
    ? trialVariance
    : deflatedSharpeThreshold(trials.length, trialVariance.value);
const cycleFile = await json<{
  cycles: { complete: boolean }[];
  rows: {
    id: string;
    cycles: {
      start: string;
      end: string;
      base: ValidationScore;
      doubledCost: ValidationScore;
      delayed: ValidationScore;
      complete: boolean;
    }[];
  }[];
}>(join(task, "low-market-cycles.json"));
const compact = (s: ValidationScore) => {
  const { daily, ...rest } = s;
  return rest;
};
const all = locations.map(({ scope, group, checkpoint: p }) => {
  const row = p.row,
    center = row.id.replace(/-neighbor-\d+$/, "");
  const siblings = locations.filter(
    (l) =>
      l.scope === scope &&
      l.checkpoint.row.id !== row.id &&
      (row.id.startsWith("book-")
        ? l.checkpoint.row.family === row.family
        : l.checkpoint.row.id.replace(/-neighbor-\d+$/, "") === center),
  );
  const neighbors = siblings.map((l) => ({
    id: l.checkpoint.row.id,
    excess: l.checkpoint.row.inSample.excess,
  }));
  const policy = {
    ...validationDefaults,
    trainBars: group.policy?.trainBars ?? 100,
    testBars: group.policy?.testBars ?? 20,
  };
  const currentRow = { ...row, neighbors };
  const test = multipleTesting(
    row.windows
      .flatMap((w) => w.base.daily)
      .filter((v): v is number => v !== null),
    trialSharpes,
  );
  const extra: string[] = [];
  const cycleEvaluation =
    scope === "csi800" && row.family === "historical-low"
      ? cycleFile.rows.find((c) => c.id === row.id)
      : undefined;
  if (
    scope === "books-cn" ||
    row.family === "historical-low" ||
    row.id.endsWith("low-zone") ||
    row.id.startsWith("book-cn-")
  ) {
    if ((group.marketCycles ?? []).filter((c) => c.complete).length < 3)
      extra.push("insufficient-complete-market-cycles");
    extra.push("low-zone-input-confidence");
  }
  if (scope.startsWith("books-"))
    extra.push("allocation-comparison-not-exit-parameter-neighborhood");
  if (test.selected.dsr.value === null || test.selected.dsr.value < 0.95)
    extra.push("multiple-testing-dsr-0.95");
  const newReasons = [
    ...validationRowReasons(currentRow, {
      ...policy,
      returnCriterion: "risk-adjusted",
    }),
    ...extra,
  ];
  if (cycleEvaluation) {
    const complete = cycleEvaluation.cycles.filter((c) => c.complete);
    if (
      !complete.length ||
      complete.filter((c) => validationScorePasses(c.base)).length /
        complete.length <
        0.6
    )
      newReasons.push("cycle-positive-risk-adjusted-majority");
    if (
      !complete.length ||
      (["doubledCost", "delayed"] as const).some(
        (kind) =>
          complete.filter((c) => validationScorePasses(c[kind])).length /
            complete.length <
          0.6,
      )
    )
      newReasons.push("cycle-cost-or-delay-stress");
  }
  const oldReasons = [
    ...validationRowReasons(currentRow, {
      ...policy,
      returnCriterion: "raw-excess",
    }),
    ...extra,
  ];
  const positive = (
    kind: "base" | "doubledCost" | "delayed",
    criterion: "risk-adjusted" | "raw-excess",
  ) =>
    row.windows.filter((w) => validationScorePasses(w[kind], criterion)).length;
  const worstDD = Math.max(
    ...[
      ...row.windows.flatMap((w) => [w.base, w.doubledCost, w.delayed]),
      row.holdout.base,
      row.holdout.doubledCost,
      row.holdout.delayed,
    ].map((s) => s.drawdown ?? Infinity),
  );
  const stable = neighbors.length
    ? neighbors.filter((n) => n.excess !== null && n.excess > 0).length /
      neighbors.length
    : 0;
  const main = scope === "csi800" || scope === "btc-eth";
  const s =
    scope === "prior1638"
      ? sensitivity.find((s) => s.id === row.id)
      : undefined;
  const scenarios = s
    ? [
        {
          valuation: "exclude",
          full: compact(s.exclude.full),
          holdout: compact(s.exclude.holdout),
        },
        ...s.outcomes.map((o) => ({
          valuation: o.valuation,
          full: compact(o.full),
          holdout: compact(o.holdout),
          terminalSettlements: o.terminalValuations.length,
        })),
      ]
    : undefined;
  return {
    scope,
    id: row.id,
    family: row.family,
    market:
      scope === "btc-eth" || scope === "prior20" || scope === "books-crypto"
        ? ("crypto" as const)
        : ("cn-equity" as const),
    level: row.id.startsWith("sleeve-")
      ? ("sleeve" as const)
      : row.id.startsWith("book-")
        ? ("market" as const)
        : ("strategy" as const),
    symbols:
      group.symbols?.length ??
      (scope === "prior20" ? 20 : scope === "prior1638" ? 1638 : null),
    full: compact(p.fullPeriod),
    holdout: {
      start: row.holdout.start,
      end: row.holdout.end,
      base: compact(row.holdout.base),
      doubledCost: compact(row.holdout.doubledCost),
      delayed: compact(row.holdout.delayed),
    },
    windows: row.windows.map((w) => ({
      ...w,
      base: compact(w.base),
      doubledCost: compact(w.doubledCost),
      delayed: compact(w.delayed),
    })),
    oosWindows: row.windows.length,
    positiveWindows: positive("base", "risk-adjusted"),
    stressPositiveWindows: {
      cost: positive("doubledCost", "risk-adjusted"),
      delay: positive("delayed", "risk-adjusted"),
    },
    oldPositiveWindows: positive("base", "raw-excess"),
    closedTrades: row.closedTrades,
    worstDrawdown: Number.isFinite(worstDD) ? worstDD : null,
    stableNeighbors: stable,
    dsr: test.selected.dsr,
    trialCount: trials.length,
    newReasons,
    oldReasons,
    newPassed: !newReasons.length,
    oldPassed: !oldReasons.length,
    promoted: main && !newReasons.length,
    scenarios,
    cycleEvaluation: cycleEvaluation?.cycles.map((c) => ({
      ...c,
      base: compact(c.base),
      doubledCost: compact(c.doubledCost),
      delayed: compact(c.delayed),
    })),
    biasTags: [
      ...(row.family === "chan-third-buy"
        ? [
            {
              code: "native-completed-prefix-selection",
              severity: "high" as const,
              detail:
                scope === "csi800"
                  ? "Only30 completed CSI800 names, including7 predeclared symbol-order supplements;not the258 eligible universe. Age/liquidity and time-budget selection remain."
                  : "Only first96 of frozen420 in original order under60-minute budget;not full-market coverage. Age/liquidity selection remains.",
            },
          ]
        : []),
      ...(scope === "csi800" || scope === "books-cn"
        ? [
            {
              code: "current-constituents-lookahead",
              severity: "high" as const,
              detail:
                "Current800, snapshot effective date unverified;258 action-eligible;earlier windows more biased;June2025 holdout primary reference",
            },
            {
              code: "execution-input-selection",
              severity: "high" as const,
              detail:
                "Only258/800 pass whole-history cash-action eligibility;541 noncash histories and1 unverified tail excluded. This is a material selection bias, not complete CSI800 coverage.",
            },
            {
              code: "historical-execution-unverified",
              severity: "high" as const,
              detail:
                "ST/IPO/queues and payment dates are unverified scenarios",
            },
          ]
        : [
            {
              code: "historical-universe-incomplete",
              severity: "high" as const,
              detail:
                scope.includes("crypto") ||
                scope.includes("20") ||
                scope === "btc-eth"
                  ? "Only user BTC/ETH or current20 selection; delisted histories incomplete"
                  : "Full-market excludes337 in base;terminal two scenarios shown, not certified proceeds",
            },
          ]),
    ],
  };
});
const promoted = all.filter((r) => r.promoted);
const closest = all
  .filter((r) => r.scope === "csi800" || r.scope === "btc-eth")
  .map((r) => {
    const gap = {
      oosWindows: Math.max(0, 3 - r.oosWindows),
      positiveFraction: Math.max(0, 0.6 - r.positiveWindows / r.oosWindows),
      costFraction: Math.max(
        0,
        0.6 - r.stressPositiveWindows.cost / r.oosWindows,
      ),
      delayFraction: Math.max(
        0,
        0.6 - r.stressPositiveWindows.delay / r.oosWindows,
      ),
      closedTrades: Math.max(0, 30 - r.closedTrades),
      drawdown:
        r.worstDrawdown === null ? null : Math.max(0, r.worstDrawdown - 0.25),
      stableNeighbors: Math.max(0, 0.5 - r.stableNeighbors),
      dsr: r.dsr.value === null ? null : Math.max(0, 0.95 - r.dsr.value),
      holdoutReturn: r.holdout.base.return,
      holdoutSharpeDifference:
        r.holdout.base.riskAdjusted?.sharpeDifference ?? null,
      holdoutCostReturn: r.holdout.doubledCost.return,
      holdoutCostSharpeDifference:
        r.holdout.doubledCost.riskAdjusted?.sharpeDifference ?? null,
      holdoutDelayReturn: r.holdout.delayed.return,
      holdoutDelaySharpeDifference:
        r.holdout.delayed.riskAdjusted?.sharpeDifference ?? null,
      marketCycles:
        r.family === "historical-low"
          ? {
              observed:
                r.cycleEvaluation?.filter((c) => c.complete).length ?? 0,
              required: 3,
              shortfall: Math.max(
                0,
                3 - (r.cycleEvaluation?.filter((c) => c.complete).length ?? 0),
              ),
            }
          : undefined,
      lowZoneInput:
        r.family === "historical-low"
          ? {
              required: "corroborated",
              actual: "price-only/approximate vintage;temperature missing",
            }
          : undefined,
      other: r.newReasons.filter(
        (x) => x.includes("cycles") || x.includes("confidence"),
      ),
    };
    return {
      scope: r.scope,
      id: r.id,
      failedCriteria: r.newReasons.length,
      reasons: r.newReasons,
      gap,
    };
  })
  .sort(
    (a, b) =>
      a.failedCriteria - b.failedCriteria ||
      (b.gap.holdoutSharpeDifference ?? -Infinity) -
        (a.gap.holdoutSharpeDifference ?? -Infinity) ||
      a.id.localeCompare(b.id),
  )
  .slice(0, 5);
const conclusion = {
  trialCount: trials.length,
  availableTrialSharpes: trialSharpes.filter((t) => t.value !== null).length,
  unavailableTrials: trials.filter((t) => t.sharpe.value === null),
  trialSharpeVariance: trialVariance,
  deflatedSharpeThreshold: familyThreshold,
  trialIdentities: trials.map((t) => ({ id: t.id, sharpe: t.sharpe })),
  rows: all,
  comparisonBooks,
  promoted: promoted.map((r) => `${r.scope}|${r.id}`),
  closest,
  fullFamily:
    "One common DSR trial distribution across all scopes, terminal valuations, strategies and actual sleeve allocations; no independent scope threshold. Computational duplicate resumes do not create a new strategy trial.",
};
const pointer = await artifact("scoreboard", conclusion);
// Persist only the main read model in the isolated research DB. No settings,
// subscriptions, notification mode, outbox or execution API writes occur here.
atomic(() => {
  const repository = new StrategyRepository();
  for (const market of ["cn-equity", "crypto"] as const) {
    const main = all.filter(
      (r) =>
        r.market === market &&
        (r.scope === "csi800" ||
          r.scope === "btc-eth" ||
          r.scope === `books-${market === "crypto" ? "crypto" : "cn"}`),
    );
    const roster =
      market === "crypto"
        ? ["cxBTCUSDT", "cxETHUSDT"]
        : locations.find((l) => l.scope === "csi800")!.group.symbols!;
    const menu = researchCandidates(roster, market).flatMap((c) => [
      c,
      ...numericNeighbors(c),
    ]);
    for (const p of promoted.filter((r) => r.market === market)) {
      const candidate = menu.find((c) => c.strategy.id === p.id);
      if (!candidate) throw new Error("Promoted candidate lacks strategy");
      repository.saveStrategy(candidate.strategy);
    }
    const rows: ScoreboardRow[] = main.map((r) => ({
      id: r.id,
      market,
      level: r.level,
      sleeve:
        r.level === "market"
          ? "combined"
          : r.family === "historical-low" || r.id.endsWith("low-zone")
            ? "low-zone"
            : r.id.includes("range-1h") ||
                r.id.includes("range-15m") ||
                r.id.endsWith("breakout")
              ? "breakout"
              : "swing",
      rule: `${r.scope}/${r.family}`,
      status: r.promoted ? "live-candidate" : "research",
      return: r.holdout.base.return,
      excess: r.holdout.base.excess,
      drawdown: r.holdout.base.drawdown,
      trades: r.closedTrades,
      oosWindows: r.oosWindows,
      positiveWindows: r.positiveWindows,
      bias: {
        universe:
          market === "cn-equity"
            ? "Current CSI800,258/800 eligible"
            : "User fixed BTC/ETH;historical venue filters unknown",
        adjustment:
          market === "crypto"
            ? "Native raw official CSV"
            : "Forward signals/backward RPS/raw fills;cash action scenario",
        financial:
          r.family === "historical-low" || r.scope === "books-cn"
            ? "Approximate vintage;temperature missing"
            : "Not used",
        execution: "Rule-check only;not verified investible performance",
      },
      riskAdjusted: r.holdout.base.riskAdjusted,
      biasTags: r.biasTags,
      reasons: r.newReasons,
    }));
    saveValidationScoreboard({
      market,
      inputHash: digest(JSON.stringify(pointers)),
      resultHash: pointer.sha256,
      buildHash: strategyBuildHash,
      rows,
      missing: [],
      createdAt: Date.now(),
      runtimeMs: 0,
      universe:
        market === "crypto"
          ? "BTC/ETH official native"
          : "Current CSI800258/800,high lookahead",
      gaps: [
        "Historical execution unverified",
        market === "cn-equity"
          ? "Current constituents lack PIT history;541 noncash action histories and1 unverified tail excluded;low temperature/financial vintages missing"
          : "Historical venue filters and capacity unverified;real archive gaps retained in manifest",
      ],
    });
  }
});
await writeFile(
  join(task, "scoreboard-summary.json"),
  JSON.stringify(conclusion, null, 2),
);
await delivery({
  results: {
    status: "complete",
    pointer,
    rows: all,
    comparisonBooks,
    trialCount: trials.length,
  },
  promoted: conclusion.promoted,
  closest,
  scoreboardPublication: {
    dataDir: join(task, "data"),
    notifications: 0,
    trades: 0,
    liveModeChanged: false,
  },
});
console.log(
  JSON.stringify({
    complete: true,
    rows: all.length,
    trials: trials.length,
    promoted: conclusion.promoted,
    pointer,
  }),
);
process.exit(0);
