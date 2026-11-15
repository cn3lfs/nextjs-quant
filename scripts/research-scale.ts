import "./lib/research-scale-isolation";
/** Offline, checkpointed R2a-3 study. Run with an absolute isolated
 * QUANT_DATA_DIR=.test-data/r2a3/data. No network or execution drivers.
 */
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rename,
} from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  researchCandidates,
  strategyBuildHash,
  type ResearchCandidate,
} from "trading-strategies";
import { runPortfolio } from "quant-backtest";
import type {
  ValidationDataset,
  FrozenValidationInput,
} from "../src/server/research/validation-capture";
import { validationInputSchema } from "../src/server/research/validation-model";
import { readCachedResearchCryptoWindow } from "../src/server/research/validation-crypto-history";
import {
  projectCandidate,
  numericNeighbors,
  combinedBook,
  projectToExecutionClock,
  validationBiasTags,
} from "../src/server/research/validation-replay";
import {
  runCandidateCheckpoint,
  joinCandidateCheckpoints,
  checkpointFamilySelection,
  type CandidateCheckpoint,
} from "../src/server/research/validation-scale";

const task = resolve(".test-data/r2a3");
if (
  !process.env.QUANT_DATA_DIR ||
  !isAbsolute(process.env.QUANT_DATA_DIR) ||
  resolve(process.env.QUANT_DATA_DIR) !== join(task, "data")
)
  throw new Error(
    "Set absolute isolated QUANT_DATA_DIR=.test-data/r2a3/data before importing application code",
  );
const artifacts = join(task, "artifacts");
await mkdir(artifacts, { recursive: true });
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function identity() {
  const hash = createHash("sha256");
  for (const root of [
    "packages/quant-backtest/src",
    "packages/trading-strategies/src",
    "packages/trading-strategy-core/src",
    "packages/quant-performance/src",
    "src/server/research",
  ]) {
    for (const name of (await readdir(root, { recursive: true }))
      .filter((n) => /\.(ts|json)$/.test(n))
      .sort()) {
      const file = join(root, name);
      hash.update(file.replaceAll("\\", "/")).update(await readFile(file));
    }
  }
  for (const file of [
    "scripts/research-scale.ts",
    "scripts/lib/research-scale-isolation.ts",
    "src/lib/backtest/multiple-testing.ts",
    "src/lib/backtest/backtest-overfit.ts",
    "src/lib/backtest/daily-performance.ts",
    "pnpm-lock.yaml",
  ])
    hash.update(file).update(await readFile(file));
  return hash.digest("hex");
}
const build = await identity();
async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
async function writeArtifact(name: string, value: unknown) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid artifact name");
  const body = JSON.stringify({ build, value });
  if (Buffer.byteLength(body) > 256 * 1024 ** 2)
    throw new Error(`Uncompressed artifact exceeds 256MiB: ${name}`);
  const bytes = gzipSync(body);
  const file = join(artifacts, `${name}.json.gz`);
  const names = await readdir(artifacts);
  let total = bytes.length;
  for (const n of names)
    if (join(artifacts, n) !== file)
      total += (await stat(join(artifacts, n))).size;
  if (
    (!names.includes(`${name}.json.gz`) && names.length >= 100) ||
    total > 4 * 1024 ** 3
  )
    throw new Error("Unchanged research artifact budget exceeded");
  await writeFile(`${file}.pending`, bytes);
  await rename(`${file}.pending`, file);
  const indexFile = join(artifacts, "index.json");
  let index: { build: string; files: Record<string, string> };
  try {
    index = await json(indexFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    index = { build, files: {} };
  }
  if (index.build !== build) throw new Error("Artifact index build changed");
  index.files[`${name}.json.gz`] = digest(bytes);
  await writeFile(`${indexFile}.pending`, JSON.stringify(index));
  await rename(`${indexFile}.pending`, indexFile);
  return { file, sha256: digest(bytes), bytes: bytes.length };
}
async function readArtifact<T>(name: string): Promise<T | null> {
  try {
    const file = join(artifacts, `${name}.json.gz`);
    if ((await stat(file)).size > 256 * 1024 ** 2)
      throw new Error("Artifact exceeds budget");
    const bytes = await readFile(file);
    const index = await json<{ build: string; files: Record<string, string> }>(
      join(artifacts, "index.json"),
    );
    if (
      index.build !== build ||
      index.files[`${name}.json.gz`] !== digest(bytes)
    )
      throw new Error(`Frozen artifact hash mismatch: ${name}`);
    const envelope = JSON.parse(
      gunzipSync(bytes, {
        maxOutputLength: 256 * 1024 ** 2,
      }).toString(),
    ) as { build: string; value: T };
    if (envelope.build !== build)
      throw new Error(
        `Research build changed: ${name}; do not reuse or reinterpret checkpoints`,
      );
    return envelope.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
type Stage = "crypto" | "cnSwing" | "cnLowZone" | "chan" | "scoreboard";
type Delivery = {
  batch: string;
  status: string;
  stages: Record<Stage, Record<string, unknown>>;
  results: Record<string, unknown>[];
  books: unknown[];
  lowZone: unknown;
  chanSubset: unknown;
  promoted: string[];
  closest: unknown[];
  gates: Record<string, unknown>;
  nextStart: string;
  [key: string]: unknown;
};
async function updateDelivery(
  stage: Stage,
  state: Record<string, unknown>,
  rows?: Record<string, unknown>[],
  books?: unknown[],
) {
  const delivery = await json<Delivery>(".codex-runs/delivery.json");
  delivery.stages[stage] = {
    ...delivery.stages[stage],
    ...state,
    updatedAt: new Date().toISOString(),
  };
  if (rows)
    delivery.results = [
      ...delivery.results.filter((r) => r.stage !== stage),
      ...rows.map((r) => ({ ...r, stage })),
    ];
  if (books)
    delivery.books = [
      ...delivery.books.filter(
        (b) => (b as { stage?: string }).stage !== stage,
      ),
      ...books.map((value) => ({ stage, value })),
    ];
  delivery.nextStart = `Continue ${stage} from verified per-candidate checkpoints; DSR remains pending until all declared candidates have joined`;
  await writeFile(
    ".codex-runs/delivery.json",
    JSON.stringify(delivery, null, 2) + "\n",
  );
}
function frozen(
  market: "crypto" | "cn-equity",
  datasets: ValidationDataset[],
  menu: ResearchCandidate[],
): FrozenValidationInput {
  return {
    version: "research-validation-input-1",
    input: validationInputSchema.parse({
      market,
      start: market === "crypto" ? "2020-01-02" : "2010-01-01",
      end: "2026-11-13",
      sampleSize: 20,
    }),
    root: "E:\\new_tdx64",
    strategyBuildHash,
    validationBuildHash: build,
    evidence: {
      universeComplete: false,
      executionVerified: false,
      firstVintageFinancials: false,
    },
    universe: null,
    datasets,
    native: [],
    financials: [],
    lowZones: [],
    rpsAudit: [],
    excluded: [],
    gaps: [],
    selection:
      "Fixed R2a-2 history selection; no outcome-dependent substitutions",
    candidateMenu: menu,
  };
}
type CryptoSource = {
  pair: string;
  period: string;
  hash: string;
  cacheFile: string;
  cacheSha256: string;
  bars: number;
  start: string;
  end: string;
};
const coverage = await json<{ rows: CryptoSource[] }>(
  ".test-data/r2a2/crypto-coverage.json",
);
async function cryptoDataset(period: ValidationDataset["period"]) {
  process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
    ".test-data/r2a2/data/bar-store",
  );
  const instruments: ValidationDataset["instruments"] = [],
    sources: ValidationDataset["sources"] = [];
  for (const expected of coverage.rows.filter((r) => r.period === period)) {
    if (digest(await readFile(expected.cacheFile)) !== expected.cacheSha256)
      throw new Error(`Frozen crypto cache drift: ${expected.pair}/${period}`);
    const view = await readCachedResearchCryptoWindow({
      instrument: { market: "crypto", symbol: `cx${expected.pair}` },
      period,
      adjustment: "none",
      cryptoSource: "binance",
      from: "1970-01-01",
      to: "2026-11-13",
      limit: 2000000,
    });
    if (
      !view ||
      view.snapshot.hash !== expected.hash ||
      view.snapshot.bars.length !== expected.bars
    )
      throw new Error("Frozen crypto projection mismatch");
    const bars = view.snapshot.bars;
    instruments.push({
      symbol: `cx${expected.pair}`,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        evidence:
          "Research grid 0.000001, historical venue filters/capacity unverified",
        minimum: 0.000001,
        step: 0.000001,
        maximum: 1e9,
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    });
    sources.push({
      symbol: `cx${expected.pair}`,
      hash: expected.hash,
      adjustmentReference: null,
    });
  }
  const benchmark = instruments.find((i) => i.symbol === "cxBTCUSDT")!.bars;
  const dates = [
    ...new Set(
      benchmark
        .map((b) => b.date.slice(0, 10))
        .filter((d) => d >= "2020-01-02" && d <= "2026-11-13"),
    ),
  ];
  if (instruments.length !== 20)
    throw new Error("Expected all 20 selected crypto pairs");
  return {
    period,
    instruments,
    benchmark: [...benchmark],
    dates,
    sources,
    benchmarkName:
      "Frozen Binance BTCUSDT buy-and-hold; first evaluation open; no benchmark costs",
  } satisfies ValidationDataset;
}
type FamilyCheckpoint = {
  family: string;
  period: string;
  symbols: number;
  build: string;
  checkpoints: CandidateCheckpoint[];
  inputHash: string;
};
function candidateSummary(
  c: CandidateCheckpoint,
  market: string,
  stage: Stage,
) {
  const r = c.row;
  return {
    id: r.id,
    market,
    sleeve:
      market === "crypto" && /range-(15m|1h)-/.test(r.id)
        ? "breakout"
        : stage === "cnLowZone"
          ? "low-zone"
          : "swing",
    family: r.family,
    inSample: r.inSample,
    holdout: r.holdout,
    oos: {
      windows: r.windows.map((w) => ({
        start: w.start,
        end: w.end,
        base: w.base,
        doubledCost: w.doubledCost,
        delayed: w.delayed,
      })),
      positiveWindows: r.positiveWindows,
      stressPositiveWindows: r.stressPositiveWindows,
      closedTrades: r.closedTrades,
    },
    riskAdjusted: r.holdout.base.riskAdjusted,
    reasons: r.reasons.filter((reason) => reason !== "parameter-neighborhood"),
    qualification: "pending-full-family-neighborhood-and-DSR",
    biasTags: [
      { code: "historical-universe-incomplete", severity: "high" },
      {
        code:
          market === "crypto"
            ? "historical-venue-filters-and-liquidity-unverified"
            : "historical-execution-unverified",
        severity: "high",
      },
    ],
    elapsedMs: c.elapsedMs,
  };
}
async function reportStage(
  stage: Stage,
  groups: FamilyCheckpoint[],
  books: unknown[] = [],
) {
  const rows = groups.flatMap((g) =>
    g.checkpoints.map((c) => ({
      ...candidateSummary(
        c,
        stage === "crypto" ? "crypto" : "cn-equity",
        stage,
      ),
      symbols: g.symbols,
      period: g.period,
      inputHash: g.inputHash,
    })),
  );
  await updateDelivery(
    stage,
    {
      status: "running",
      candidatesCompleted: rows.length,
      elapsedMs: groups
        .flatMap((g) => g.checkpoints)
        .reduce((n, c) => n + c.elapsedMs, 0),
    },
    rows,
    books,
  );
  const file = "docs/research/2026-11-scoreboard.md";
  let body = await readFile(file, "utf8");
  if (!body.includes("<!-- R2A3:INTRO -->"))
    body =
      "# 2026-11 R2a-3 规模化策略研究成绩单\n\n<!-- R2A3:INTRO -->\n阶段性，后续阶段未完成。数字来自 `.test-data/r2a3/artifacts/` 的逐候选检查点；全族 DSR 和最终资格待全部阶段合并。三项免费数据缺口只作 high 偏差标签；统计门槛不变。样本外不回头调参，提醒 live 模式保持关闭。\n\n";
  const begin = `<!-- R2A3:${stage}:BEGIN -->`,
    end = `<!-- R2A3:${stage}:END -->`;
  const pct = (v: unknown) =>
    typeof v === "number" ? `${(100 * v).toFixed(2)}%` : "—";
  const lines = [
    begin,
    `## ${stage}（阶段性，后续阶段未完成）`,
    "",
    "每行留出段收益/超额/回撤；窗口与闭合交易取独立本金的滚动样本外。完整逐窗、训练、压力、风险调整差见 delivery 的 results。全族 DSR 未完成前不发布晋级。",
    "",
    "| 策略 | 周期/标的 | 留出收益/超额/回撤 | 成本×2/延迟超额 | 正超额窗/总窗 · 闭合交易 |",
    "|---|---|---|---|---|",
    ...groups.flatMap((g) =>
      g.checkpoints.map(
        ({ row: r }) =>
          `| ${r.id} | ${g.period}/${g.symbols} | ${pct(r.holdout.base.return)}/${pct(r.holdout.base.excess)}/${pct(r.holdout.base.drawdown)} | ${pct(r.holdout.doubledCost.excess)}/${pct(r.holdout.delayed.excess)} | ${r.positiveWindows}/${r.windows.length} · ${r.closedTrades} |`,
      ),
    ),
    "",
    `组合账本：${books.length} 组（原始分仓收益、相关性和划转见 delivery.books）。`,
    "",
    end,
  ];
  const section = lines.join("\n");
  const from = body.indexOf(begin),
    to = body.indexOf(end);
  body =
    from >= 0 && to >= from
      ? body.slice(0, from) + section + body.slice(to + end.length)
      : body + "\n" + section + "\n";
  await writeFile(file, body);
}
async function runFamily(
  stage: Stage,
  dataset: ValidationDataset,
  base: FrozenValidationInput,
  family: string,
) {
  const name = `candidate-${stage.toLowerCase()}-${family}`;
  const inputHash = digest(
    JSON.stringify({
      build,
      sources: dataset.sources,
      symbols: dataset.instruments.map((i) => i.symbol),
      dates: dataset.dates,
      menu: base.candidateMenu,
      native: base.native.map((n) => n.capture.identity),
    }),
  );
  const saved = await readArtifact<FamilyCheckpoint>(name);
  if (saved && saved.inputHash !== inputHash)
    throw new Error("Checkpoint input identity mismatch");
  const group: FamilyCheckpoint = saved ?? {
    family,
    period: dataset.period,
    symbols: dataset.instruments.length,
    build,
    checkpoints: [],
    inputHash,
  };
  const declared = base.candidateMenu
    .filter((c) => c.family === family)
    .flatMap((c) => [c, ...numericNeighbors(c)]);
  const cache = new Map();
  for (const c of declared) {
    if (group.checkpoints.some((p) => p.row.id === c.strategy.id)) continue;
    console.log(
      JSON.stringify({
        phase: "candidate-start",
        stage,
        id: c.strategy.id,
        symbols: dataset.instruments.length,
        at: new Date().toISOString(),
      }),
    );
    const projected = projectCandidate(c, dataset, base, cache);
    if (!projected) throw new Error("Required candidate inputs unavailable");
    const policy = {
      ...base.input.policy,
      trainBars: Math.max(20, Math.floor(dataset.dates.length * 0.4)),
      testBars: Math.max(5, Math.floor(dataset.dates.length * 0.1)),
    };
    const result = runCandidateCheckpoint(projected, dataset, policy);
    group.checkpoints.push(result);
    await writeArtifact(name, group);
    const groups = await readGroups(stage);
    await reportStage(stage, groups);
    console.log(
      JSON.stringify({
        phase: "candidate-complete",
        stage,
        id: c.strategy.id,
        elapsedMs: result.elapsedMs,
        at: new Date().toISOString(),
      }),
    );
    // Each complete candidate is a resumable checkpoint, including a >60min job.
  }
  return group;
}
async function readGroups(stage: Stage) {
  const groups: FamilyCheckpoint[] = [];
  for (const name of (await readdir(artifacts))
    .filter(
      (n) =>
        n.startsWith(`candidate-${stage.toLowerCase()}-`) &&
        n.endsWith(".json.gz"),
    )
    .sort())
    groups.push((await readArtifact<FamilyCheckpoint>(name.slice(0, -8)))!);
  return groups;
}
export {
  task,
  artifacts,
  build,
  digest,
  json,
  writeArtifact,
  readArtifact,
  updateDelivery,
  frozen,
  runFamily,
  readGroups,
  reportStage,
  candidateSummary,
};
export type { FamilyCheckpoint, Delivery, Stage };

const command =
  resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    ? process.argv[2]
    : "library";
if (command === "library") {
  // Shared CLI support; importing does not start a study.
} else if (command === "crypto") {
  const started = performance.now();
  await writeArtifact("crypto-input", {
    evaluationStart: "2020-01-02",
    end: "2026-11-13",
    selection: await json(".test-data/r2a2/crypto-selection-evidence.json"),
    coverage,
    strategyBuildHash,
    noMigrationSplice: true,
    terminalPolicy:
      "Retain BREAK pairs. No entries after last complete bar; any remaining position marked at its last observed close, with unverified terminal-settlement high bias. No invented liquidation.",
  });
  await updateDelivery("crypto", {
    status: "running",
    startedAt: new Date().toISOString(),
    pairs: 20,
    start: "2020-01-02",
    end: "2026-11-13",
  });
  for (const period of ["day", "4h", "1h", "15m"] as const) {
    const dataset = await cryptoDataset(period);
    const menu = researchCandidates(
      dataset.instruments.map((i) => i.symbol),
      "crypto",
    ).filter((c) => c.strategy.period === period);
    const base = frozen("crypto", [dataset], menu);
    for (const family of [...new Set(menu.map((c) => c.family))])
      await runFamily("crypto", dataset, base, family);
  }
  await updateDelivery("crypto", {
    status: "candidates-complete-books-pending",
    elapsedMs: performance.now() - started,
  });
} else if (command === "crypto-books") {
  const base = await cryptoDataset("15m"),
    swing = await cryptoDataset("4h"),
    breakout = await cryptoDataset("1h");
  const menu = researchCandidates(
    base.instruments.map((i) => i.symbol),
    "crypto",
  );
  const frozenInput = frozen("crypto", [base, swing, breakout], menu);
  const a = projectCandidate(
    menu.find((c) => c.family === "dual-ma-4h" && c.variant === "atr")!,
    swing,
    frozenInput,
    new Map(),
  )!;
  const b = projectCandidate(
    menu.find((c) => c.family === "range-1h" && c.variant === "atr")!,
    breakout,
    frozenInput,
    new Map(),
  )!;
  const book = combinedBook(
    frozenInput,
    base,
    projectToExecutionClock(a.request, base, 16),
    projectToExecutionClock(b.request, base, 4),
  );
  await writeArtifact("crypto-books", book);
  await reportStage("crypto", await readGroups("crypto"), [book]);
  await updateDelivery("crypto", {
    status: "complete-statistics-provisional",
    candidates: 54,
    pairs: 20,
    multipleTesting: "Deferred to all 117 declared strategy variants together",
  });
} else if (command === "verify") {
  const index = await json<{ build: string; files: Record<string, string> }>(
    join(artifacts, "index.json"),
  );
  for (const name of Object.keys(index.files))
    await readArtifact(name.slice(0, -8));
  console.log(
    JSON.stringify({
      verified: true,
      files: Object.keys(index.files).length,
      indexHash: digest(await readFile(join(artifacts, "index.json"))),
      build,
    }),
  );
} else if (command === "status") {
  console.log(JSON.stringify(await json(".codex-runs/delivery.json")));
} else throw new Error("Expected crypto, crypto-books or status");
if (command !== "library") process.exit(0);
