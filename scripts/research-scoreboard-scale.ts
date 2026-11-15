import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import "./lib/research-scale-isolation";
/** Join the complete R2a-3 trial family; publish only into its isolated DB. */
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  studySourceIdentity,
  studySourceRoots,
} from "./lib/research-scale-sources";
import {
  researchCandidates,
  strategyBuildHash,
  lowZoneCycles,
} from "trading-strategies";
import type { ScoreboardRow } from "../src/server/research/validation-model";
import { validationInputSchema } from "../src/server/research/validation-model";
import {
  joinCandidateCheckpoints,
  checkpointFamilySelection,
} from "../src/server/research/validation-scale";
import { combinatoriallySymmetricCv } from "../src/lib/backtest/backtest-overfit";
import {
  multipleTesting,
  sharpeDaily,
} from "../src/lib/backtest/multiple-testing";
import { StrategyRepository } from "../src/server/db/strategy-repository";
import { saveValidationScoreboard } from "../src/server/db/validation-scoreboard";
import { atomic, get, sqlite } from "../src/server/db";
import { numericNeighbors } from "../src/server/research/validation-replay";
import { readCachedResearchCryptoWindow } from "../src/server/research/validation-crypto-history";
import { indexFacts } from "../src/server/research/index-context";
import type { Bar } from "trading-strategy-core/bars";
import {
  task,
  artifacts,
  build,
  digest,
  json,
  readArtifact,
  writeArtifact,
  readGroups,
  candidateSummary,
  type Delivery,
  type FamilyCheckpoint,
  type Stage,
} from "./research-scale";

const command = process.argv[2] ?? "finalize";
const sourceIdentity = await studySourceIdentity();
if (command === "verify") {
  const expected =
    await readArtifact<Awaited<ReturnType<typeof studySourceIdentity>>>(
      "source-identity",
    );
  if (!expected || expected.hash !== sourceIdentity.hash)
    throw new Error("Frozen study reader/adapter code changed; refuse replay");
} else {
  const changed = execFileSync(
    "git",
    [
      "diff",
      "2b72c99",
      "--",
      ...studySourceRoots,
      "src/server/data-sources/tdx/local-financial-files.ts",
      "src/server/strategies/strategy-center-native.ts",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (changed.trim())
    throw new Error(
      "Reader/capture adapters changed from the accepted R2a-2 lineage during this study",
    );
  await writeArtifact("source-identity", {
    ...sourceIdentity,
    lineage:
      "Actual reader/capture source files unchanged from accepted 2b72c99; added metadata before publishing, no price/strategy result reinterpreted",
  });
}
const stages = ["crypto", "cnSwing", "cnLowZone", "chan"] as const;
const groups = (
  await Promise.all(
    stages.map(async (stage) =>
      (await readGroups(stage)).map((group) => ({ stage, group })),
    ),
  )
).flat();
if (
  groups.length !== 13 ||
  groups.reduce((n, g) => n + g.group.checkpoints.length, 0) !== 117
)
  throw new Error("Full trial family incomplete; do not infer zero promotions");
const policy = {
  ...validationInputSchema.parse({
    market: "cn-equity",
    start: "2010-01-01",
    end: "2026-11-13",
  }).policy,
  trainBars: 20,
  testBars: 5,
};
const all = groups.flatMap((g) => g.group.checkpoints);
const joined = joinCandidateCheckpoints(all, policy);
const equity = (await readArtifact<{
  eligible: string[];
  audit: { symbol: string; accepted: boolean; reason: string }[];
  elapsedMs: number;
  benchmark: Bar[];
}>("equity-input"))!;
const low = (await readArtifact<{
  stocks: number;
  shards: string[];
  benchmark: { observations: Parameters<typeof lowZoneCycles>[0] };
  elapsedMs: number;
}>("low-input"))!;
const native =
  (await readArtifact<
    { symbol: string; capture: unknown; elapsedMs: number }[]
  >("native-input"))!;
const cycles = lowZoneCycles(low.benchmark.observations).filter(
  (c) => c.start >= "2010-01-01",
);
const find = (id: string) =>
  groups.find((g) => g.group.checkpoints.some((c) => c.row.id === id))!;
const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${displayNumber(100 * n, 2)}%`;
const metric = (n: number | null | undefined) =>
  n == null ? "—" : displayNumber(n, 4);

const rpsRoot = JSON.parse((await readArtifact<string>("rps-root"))!) as {
  dates: string[];
};
const axes = new Map<
  string,
  { dates: string[]; regimes: Map<string, string> }
>();
const classify = (bars: Bar[], dates: string[]) =>
  new Map(
    dates.map((date) => {
      const f = indexFacts(bars, date);
      return [
        date,
        f.close === null || f.ma20 === null || f.ma60 === null
          ? "unknown"
          : f.close > f.ma60 && f.ma20 > f.ma60
            ? "rising"
            : f.close < f.ma60 && f.ma20 < f.ma60
              ? "falling"
              : "mixed",
      ];
    }),
  );
axes.set("cn-equity:day", {
  dates: rpsRoot.dates,
  regimes: classify(equity.benchmark, rpsRoot.dates),
});
const cryptoInput = (await readArtifact<{
  coverage: {
    rows: {
      pair: string;
      period: string;
      hash: string;
      cacheFile: string;
      cacheSha256: string;
    }[];
  };
}>("crypto-input"))!;
process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
  ".test-data/r2a2/data/bar-store",
);
for (const period of ["day", "4h", "1h", "15m"] as const) {
  const expected = cryptoInput.coverage.rows.find(
    (r) => r.pair === "BTCUSDT" && r.period === period,
  )!;
  if (digest(await readFile(expected.cacheFile)) !== expected.cacheSha256)
    throw new Error("Frozen benchmark source drift");
  const view = await readCachedResearchCryptoWindow({
    instrument: { market: "crypto", symbol: "cxBTCUSDT" },
    period,
    adjustment: "none",
    cryptoSource: "binance",
    from: "1970-01-01",
    to: "2026-11-13",
    limit: 2000000,
  });
  if (!view || view.snapshot.hash !== expected.hash)
    throw new Error("Frozen benchmark projection drift");
  const daily = new Map<string, Bar>();
  for (const bar of view.snapshot.bars)
    daily.set(bar.date.slice(0, 10), { ...bar, date: bar.date.slice(0, 10) });
  const dates = [...daily.keys()].filter(
    (d) => d >= "2020-01-02" && d <= "2026-11-13",
  );
  axes.set(`crypto:${period}`, {
    dates,
    regimes: classify([...daily.values()], dates),
  });
}

const rows = joined.map((c) => {
  const { stage, group } = find(c.row.id);
  const market =
    stage === "crypto" ? ("crypto" as const) : ("cn-equity" as const);
  const sleeve =
    stage === "cnLowZone"
      ? "low-zone"
      : market === "crypto" && /range-(15m|1h)-/.test(c.row.id)
        ? "breakout"
        : "swing";
  const axis = axes.get(`${market}:${group.period}`)!;
  const regimes = ["rising", "falling", "mixed", "unknown"].map((regime) => {
    const values: number[] = [];
    for (const window of c.row.windows) {
      const dates = axis.dates.filter(
        (d) => d >= window.start && d <= window.end,
      );
      if (dates.length !== window.base.daily.length)
        throw new Error("Regime attribution daily axis mismatch");
      window.base.daily.forEach((value, i) => {
        if (value !== null && axis.regimes.get(dates[i]!) === regime)
          values.push(value);
      });
    }
    return {
      regime,
      observations: values.length,
      conditionalReturn: values.length
        ? values.reduce((nav, r) => nav * (1 + r), 1) - 1
        : null,
      boundary:
        "Conditional OOS daily attribution, not a continuous investible path or full market temperature",
    };
  });
  const reasons = [...c.row.reasons];
  if (sleeve === "low-zone") {
    if (
      cycles.filter((cycle) => cycle.complete).length <
      policy.minimumMarketCycles
    )
      reasons.push("insufficient-complete-market-cycles");
    reasons.push("low-zone-input-confidence");
  }
  const board: ScoreboardRow = {
    id: c.row.id,
    level: "strategy",
    market,
    sleeve,
    rule: `${c.row.family} / ${group.period}`,
    status: reasons.length ? "research" : "live-candidate",
    return: c.row.holdout.base.return,
    excess: c.row.holdout.base.excess,
    drawdown: c.row.holdout.base.drawdown,
    trades: c.row.closedTrades,
    oosWindows: c.row.windows.length,
    positiveWindows: c.row.positiveWindows,
    riskAdjusted: c.row.holdout.base.riskAdjusted,
    biasTags: [
      {
        code: "historical-universe-incomplete",
        severity: "high",
        detail:
          "Known local/current exchange roster cannot enumerate all removed securities",
      },
      {
        code:
          market === "crypto"
            ? "historical-venue-filters-and-liquidity-unverified"
            : "historical-execution-unverified",
        severity: "high",
        detail:
          market === "crypto"
            ? "Historical venue filters, terminal settlement and liquidity unverified"
            : "Historical ST/IPO/queue/cash-payment dates are uncertified scenarios",
      },
    ],
    bias: {
      universe:
        market === "crypto"
          ? "Fixed 2020-01-01 volume selection, 20 original pairs incl BREAK"
          : `Frozen full-market RPS 5564; ${equity.eligible.length} terminal-audited executable scenarios`,
      adjustment:
        market === "crypto"
          ? "Raw Binance spot OHLC; no token migration splice"
          : "Forward signals at frozen denominator / backward full-market RPS / raw fills",
      financial:
        sleeve === "low-zone"
          ? "PIT announcements; current revisions approximate, missing market temperature"
          : "Not used",
      execution:
        "Rule-check-only; next-open, fee/slippage scenario, unverified historical execution",
    },
    reasons,
  };
  const scores = [
    ...c.row.windows.flatMap((w) => [w.base, w.doubledCost, w.delayed]),
    c.row.holdout.base,
    c.row.holdout.doubledCost,
    c.row.holdout.delayed,
  ];
  const worstDrawdown = scores.some((s) => s.drawdown === null)
    ? null
    : Math.max(...scores.map((s) => s.drawdown!));
  const stable = c.row.neighbors.length
    ? c.row.neighbors.filter((n) => n.excess !== null && n.excess > 0).length /
      c.row.neighbors.length
    : null;
  const gap = {
    windows: { actual: c.row.windows.length, minimum: policy.minimumWindows },
    positiveWindows: {
      actual: c.row.positiveWindows,
      denominator: c.row.windows.length,
      minimumFraction: policy.minimumPositiveWindows,
    },
    stressWindows: {
      actual: c.row.stressPositiveWindows,
      denominator: c.row.windows.length,
      minimumFraction: policy.minimumPositiveWindows,
    },
    holdout: {
      excess: c.row.holdout.base.excess,
      doubledCost: c.row.holdout.doubledCost.excess,
      delayOneBar: c.row.holdout.delayed.excess,
      require: ">0 for each",
    },
    worstDrawdown: {
      actual: worstDrawdown,
      maximum: policy.maximumDrawdown,
      excessOverLimit:
        worstDrawdown === null
          ? null
          : Math.max(0, worstDrawdown - policy.maximumDrawdown),
    },
    closedTrades: {
      actual: c.row.closedTrades,
      minimum: policy.minimumTrades,
      missing: Math.max(0, policy.minimumTrades - c.row.closedTrades),
    },
    stableNeighbors: { actual: stable, minimum: policy.minimumStableNeighbors },
    dsr: {
      actual: c.testing.selected.dsr.value,
      minimum: policy.minimumDsr,
      shortfall:
        c.testing.selected.dsr.value === null
          ? null
          : Math.max(0, policy.minimumDsr - c.testing.selected.dsr.value),
      reason: c.testing.selected.dsr.reason,
    },
    ...(sleeve === "low-zone"
      ? {
          cycles: {
            actual: cycles.filter((cycle) => cycle.complete).length,
            minimum: policy.minimumMarketCycles,
          },
          confidence: "price-only; corroborated required",
        }
      : {}),
  };
  return {
    ...candidateSummary(c, market, stage),
    stage,
    symbols: group.symbols,
    period: group.period,
    inputHash: group.inputHash,
    reasons,
    qualification: board.status,
    neighbors: c.row.neighbors,
    dsr: c.testing,
    gateGaps: gap,
    board,
    regimes,
  };
});
const closest = [...rows]
  .sort(
    (a, b) =>
      a.reasons.length - b.reasons.length ||
      (b.dsr.selected.dsr.value ?? -Infinity) -
        (a.dsr.selected.dsr.value ?? -Infinity) ||
      a.id.localeCompare(b.id),
  )
  .slice(0, 5)
  .map((r) => ({
    id: r.id,
    reasons: r.reasons,
    gates: r.gateGaps,
    rankRule:
      "Fewest failed frozen gates, then higher DSR, then stable ID; descriptive distance only, never new parameters",
  }));
const selection = checkpointFamilySelection(all);
const cscv = combinatoriallySymmetricCv({
  returns: all.map((c) => c.fullPeriod.daily),
  metric: "sharpe",
});
const diagnostics = {
  trialsLowerBound: 117,
  allTrialIds: rows.map((r) => r.id),
  sameTrialFamilyForEveryCandidate: true,
  cscv,
  selection,
  boundary:
    "DSR uses all 117 daily Sharpe trials, including every market/timeframe/exit/neighbor; no partition-wise promotion. Different market calendars/coverage prevent a complete contemporaneous 117-row CSCV matrix; its unavailable result is preserved, never filled or split into favorable cohorts. Holdout overlaps rolling OOS and is not another independent sample.",
};
const books = [
  (await readArtifact<{ rows: ScoreboardRow[] }>("crypto-books"))!,
  (await readArtifact<{ rows: ScoreboardRow[] }>("equity-books"))!,
];
if (books.some((b) => !b)) throw new Error("Market sleeve books incomplete");
const delivery = await json<Delivery>(".codex-runs/delivery.json");
if (command === "verify") {
  const saved = (await readArtifact<{
    rows: typeof rows;
    closest: typeof closest;
    diagnostics: typeof diagnostics;
    finalizeCodeHash: string;
  }>("scoreboard"))!;
  if (
    saved.finalizeCodeHash !== digest(await readFile(new URL(import.meta.url)))
  )
    throw new Error(
      "Frozen scoreboard finalizer version changed; refuse replay",
    );
  if (
    JSON.stringify(saved.rows) !== JSON.stringify(rows) ||
    JSON.stringify(saved.closest) !== JSON.stringify(closest) ||
    JSON.stringify(saved.diagnostics) !== JSON.stringify(diagnostics)
  )
    throw new Error("Scoreboard/whole-family statistics replay differs");
  console.log(
    JSON.stringify({
      verified: true,
      candidates: rows.length,
      trials: 117,
      scope:
        "Exact checkpoint aggregation, all gate decisions and family training selectors; no new strategy execution",
    }),
  );
} else if (command === "finalize") {
  const artifact = await writeArtifact("scoreboard", {
    rows,
    closest,
    diagnostics,
    sourceArtifacts: await json(join(artifacts, "index.json")),
    finalizeCodeHash: digest(await readFile(new URL(import.meta.url))),
  });
  atomic(() => {
    const repository = new StrategyRepository();
    for (const market of ["crypto", "cn-equity"] as const) {
      const symbols = market === "crypto" ? coverageSymbols() : equity.eligible;
      const menu = researchCandidates(symbols, market).flatMap((c) => [
        c,
        ...numericNeighbors(c),
      ]);
      for (const candidate of menu) {
        const own = find(candidate.strategy.id);
        const strategy = {
          ...candidate.strategy,
          universe: {
            kind: "symbols" as const,
            symbols:
              own.stage === "chan" ? native.map((n) => n.symbol) : symbols,
          },
          version:
            Number.parseInt(
              digest(
                `${build}:${own.group.inputHash}:${candidate.strategy.id}`,
              ).slice(0, 12),
              16,
            ) + 1,
        };
        repository.saveStrategy(strategy);
      }
      saveValidationScoreboard({
        market,
        inputHash: digest(
          JSON.stringify(
            groups
              .filter((g) => (market === "crypto") === (g.stage === "crypto"))
              .map((g) => g.group.inputHash),
          ),
        ),
        resultHash: artifact.sha256,
        buildHash: strategyBuildHash,
        rows: [
          ...rows.filter((r) => r.board.market === market).map((r) => r.board),
          ...books.flatMap((b) => b.rows.filter((r) => r.market === market)),
        ],
        missing: [],
        createdAt: Date.now(),
        runtimeMs: groups
          .filter((g) => (market === "crypto") === (g.stage === "crypto"))
          .flatMap((g) => g.group.checkpoints)
          .reduce((n, c) => n + c.elapsedMs, 0),
        universe:
          market === "crypto"
            ? "Fixed historical volume selection"
            : "incomplete-local",
        gaps: [diagnostics.boundary],
      });
    }
  });
  delivery.results = rows.map(({ board: _board, ...row }) => row);
  delivery.promoted = rows
    .filter((r) => r.board.status === "live-candidate")
    .map((r) => r.id);
  delivery.closest = delivery.promoted.length ? [] : closest;
  delivery.books = books;
  delivery.diagnostics = diagnostics;
  for (const stage of stages)
    delivery.stages[stage] = {
      ...delivery.stages[stage],
      status: "complete",
      candidates: rows.filter((r) => r.stage === stage).length,
    };
  delivery.stages.scoreboard = {
    status: "complete",
    candidates: 117,
    promoted: delivery.promoted.length,
    artifact,
  };
  delivery.status = "research-complete-verification-pending";
  delivery.nextStart =
    "Run final source/cache/whole-family verification, unchanged bar-store performance gate, pnpm normalize:eol, git diff --check, pnpm check --build seven stages, desktop prepare/P0, then guarded cleanup preview";
  delivery.runtime = {
    candidateMs: all.reduce((n, c) => n + c.elapsedMs, 0),
    equityCaptureMs: equity.elapsedMs,
    lowCaptureMs: low.elapsedMs,
    nativeCaptureMs: native.reduce((n, n2) => n + n2.elapsedMs, 0),
  };
  delivery.schemaImpact = {
    version: sqlite().pragma("user_version", { simple: true }),
    newMigration: false,
    userDatabaseOpened: false,
    alertMode:
      get<{ alerts?: { mode?: string } }>("settings")?.alerts?.mode ?? "shadow",
    notifications: sqlite()
      .prepare("SELECT COUNT(*) AS n FROM watch_events")
      .get(),
    boundary:
      "Qualifications and scoreboards only in absolute isolated task data directory; no subscriptions/live activation/orders",
  };
  await writeFile(
    ".codex-runs/delivery.json",
    JSON.stringify(delivery, null, 2) + "\n",
  );
  let report = "# 2026-11 R2a-3 规模化策略研究成绩单\n\n## 已证实\n\n";
  report += `已跑完 ${rows.length} 个策略变体，统计晋级 ${delivery.promoted.length} 个。研究事实可由冻结输入、逐候选检查点和全族统计重放核对；不等同于可信实盘业绩。三类免费数据缺口为 high 标签，不阻断晋级。其余门槛未修改；无样本外回头调参。\n\n`;
  const excludedReasons = new Map<string, number>();
  for (const row of equity.audit.filter((r) => !r.accepted)) {
    const reason = row.reason.startsWith("Unverified terminal coverage")
      ? "终止行情未覆盖共同终点且无结算证据"
      : row.reason;
    excludedReasons.set(reason, (excludedReasons.get(reason) ?? 0) + 1);
  }
  report += `A股：5564只横截面RPS根哈希 \`e66c660f3ccca359c803a06743f6322ddc62d0e9bd825d32d33cf5996ad97bd4\`，1975只初步可执行池审计后 ${equity.eligible.length} 只完成到2026-11-13；排除 ${equity.audit.length - equity.eligible.length} 只（${[...excludedReasons].map(([reason, count]) => `${reason}：${count}只`).join("；")}），逐项排除见 delivery.stages.cnSwing.excluded。波段和低位每候选均为单个共享现金账户，2010年起；低位检测覆盖全部 ${low.stocks} 只及沪深300，不将非现金行动排除股当作历史不存在。三买为预先排序、在原有产物资源边界内串行完成的 ${native.length} 只子集；60分钟仅为检查点而非总体采集时限，选法、顺序、失败及耗时见 delivery.chanSubset。\n\n`;
  report +=
    "数字货币：2020-01-01 UTC成交额前20名原币对，统一从2020-01-02评价至2026-11-13，日线/4h/1h/原生15m；BREAK币对保留、不换今日赢家或拼接迁移币。已移除币对枚举不全、终止结算、数量/容量未核验明确保留。末根之后不造平仓，剩余持仓采用最后真实观察价格标记，不能解释为可结算现金。\n\n";
  report +=
    "固定训练40%、测试10%滚动（每窗独立本金），训练只按扣费超额→回撤→ID选择；末20%留出与滚动样本外重叠。门槛：≥3窗、≥60%正超额窗、成本×2/延迟一根压力、所有测试/留出压力回撤≤25%、≥30闭合交易、初始训练邻域≥50%正超额、DSR≥0.95。低位另需≥3完整市场周期和输入置信。\n\n";
  report += `多重检验一次包含全族117个尝试，不按市场/周期拆分。策略表的风险调整差取留出段，DSR取拼接的滚动样本外日收益；风险调整差仅并列展示（quant-performance日收盘、252观测年化、2%无风险），不参与选择或门槛。全族CSCV保留不可用原因：${JSON.stringify(cscv)}；不同日历/长度不补零、不拿局部通过率替代全族。\n\n`;
  for (const stage of stages) {
    report += `### ${stage}\n\n| 策略 | 周期/标的 | 训练超额 | 留出收益/超额/回撤 | 成本×2/延迟超额 | 正超额窗/总窗·闭合交易 | DSR | 夏普差/Calmar差 | 结论 |\n|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of rows.filter((r) => r.stage === stage))
      report += `| ${r.id} | ${r.period}/${r.symbols} | ${pct(r.inSample.excess)} | ${pct(r.holdout.base.return)}/${pct(r.holdout.base.excess)}/${pct(r.holdout.base.drawdown)} | ${pct(r.holdout.doubledCost.excess)}/${pct(r.holdout.delayed.excess)} | ${r.oos.positiveWindows}/${r.oos.windows.length}·${r.oos.closedTrades} | ${metric(r.dsr.selected.dsr.value)} | ${metric(r.riskAdjusted?.sharpeDifference)}/${metric(r.riskAdjusted?.calmarDifference)} | ${r.qualification}: ${r.reasons.join("；")} |\n`;
    report +=
      "\n每行偏差：historical-universe-incomplete（high）；A股 historical-execution-unverified / 币种 historical-venue-filters-and-liquidity-unverified（high）。低位另标本地财务修订、公告时点过滤及温度缺失；其他候选未使用财务。零观察/零交易不归因执行阶段。\n\n";
  }
  report +=
    "### 样本外市场状态归因\n\n按相同基准的完成收盘/SMA20/SMA60分组；条件日收益连乘仅作归因，不能当作连续可投资路径，也不等于完整市场温度。零观测状态收益留空。\n\n| 策略 | rising日/条件收益 | falling日/条件收益 | mixed日/条件收益 | unknown日/条件收益 |\n|---|---|---|---|---|\n";
  for (const row of rows)
    report += `| ${row.id} | ${row.regimes.map((r) => `${r.observations}/${pct(r.conditionalReturn)}`).join(" | ")} |\n`;
  report +=
    "\n### 分仓与市场组合\n\n固定ATR代表在看结果前选定，组合是全期描述回放，不能视为独立样本外晋级。共同账户按实际完成bar时钟撮合，只划转闲置现金、不强制平仓。币种4h波段/1h突破投影到15m，比较75/25和80/20；A股比较低位0/30/35/40动态与固定65/35。分仓收益扣除现金划转、零资本日留空。\n\n";
  for (const book of books as unknown as {
    market: string;
    variants: {
      name: string;
      shares: unknown;
      score: {
        return: number | null;
        excess: number | null;
        drawdown: number | null;
      };
      correlation: number | null;
      overlapDays: number;
      sleeveScores: {
        sleeve: string;
        return: number | null;
        drawdown: number | null;
        observed: number;
      }[];
    }[];
  }[])
    for (const v of book.variants)
      report += `- ${book.market} / ${v.name} / ${JSON.stringify(v.shares)}：收益${pct(v.score.return)}，超额${pct(v.score.excess)}，回撤${pct(v.score.drawdown)}；分仓相关性${metric(v.correlation)}，有效重叠${v.overlapDays}日。分仓：${v.sleeveScores.map((s) => `${s.sleeve} 收益${pct(s.return)}/回撤${pct(s.drawdown)}/${s.observed}日`).join("；")}。\n`;
  const allocation = (books[1] as unknown as { dynamicAllocation: unknown })
    .dynamicAllocation;
  report += `\nA股动态低位目标份额的实际日数分布：\`${JSON.stringify(allocation)}\`。该分布由原有“指数或合格个股中最深低位”规则产生，扩池后的启用频度如实保留，未根据样本外结果回头调整。\n`;
  const completeCycles = cycles.filter((c) => c.complete).length;
  report += `\n### 低位检测与周期\n\n全部${low.stocks}只价格/财务时点检测的触发、恢复、覆盖及周期见 low-* 冻结分片，价格只取全市场RPS已冻结的后复权收盘；前/后复权固定分母的同股比例关系提供可比的价格分位/回撤口径，两条数据路径均明示。证券现金回放仍只在终止审计通过池中进行。沪深300可用区间的完整低位周期 ${completeCycles} 个，${completeCycles >= policy.minimumMarketCycles ? "达到" : "未达到"}${policy.minimumMarketCycles}个周期门槛；历史温度缺失，不能冒称corroborated。价格本身的循环次数不替代市场周期或长线资金业绩。\n\n`;
  const cycleResults = (await readArtifact<{
    marketCycles: {
      id: string;
      cycles: {
        start: string;
        end: string;
        complete: boolean;
        score: {
          return: number | null;
          excess: number | null;
          drawdown: number | null;
          trades: number;
        };
      }[];
    }[];
  }>("low-cycles"))!;
  for (const row of cycleResults.marketCycles)
    for (const cycle of row.cycles)
      report += `- ${row.id} / ${cycle.start}至${cycle.end} / 完整${cycle.complete}：收益${pct(cycle.score.return)}，超额${pct(cycle.score.excess)}，回撤${pct(cycle.score.drawdown)}，闭合${cycle.score.trades}笔。\n`;
  if (!delivery.promoted.length)
    report += `### 最接近的五名及逐项门槛差距\n\n按未通过门槛个数、DSR、稳定ID排序，仅作描述。\n\n${closest.map((r, i) => `${i + 1}. **${r.id}**：${r.reasons.join("；")}。逐项值/阈值：\`${JSON.stringify(r.gates)}\`。`).join("\n\n")}\n\n`;
  report +=
    "## 推测与未核实\n\n当前结果不能分离证券池选择、未认证执行/终止估值、数据修订与价格规则本身的贡献，不以高严重度偏差标签解释所有亏损。全族DSR的117次是尝试数下界，各市场日历/历史覆盖不同，统计适用性仍有限；不把CSCV缺失说成通过。未来过滤或退出研究须另行预先冻结设计与新窗口，不能用这次样本外反调参数。资格不启用提醒live、订阅或交易；真实影子运行和账户认证仍独立验收。\n\n";
  report += `冻结产物：\`.test-data/r2a3/artifacts/index.json\`；输入/结果 SHA256随索引，研究代码身份\`${build}\`。重放统计：设置绝对隔离QUANT_DATA_DIR后，\`pnpm exec tsx scripts/research-scale.ts verify\`、\`pnpm exec tsx scripts/research-scoreboard-scale.ts verify\`。全量重新计算按 scripts/research-scale.ts、research-equity-scale.ts 的阶段命令；原生采集使用任务内预声明并固定哈希的 native-resource-capture.ts（其声明、顺序和资源终止证据随冻结输入保留）；同一构建可逐候选续跑，版本漂移拒绝复用。\n`;
  await writeFile("docs/research/2026-11-scoreboard.md", report);
  console.log(
    JSON.stringify({
      complete: true,
      rows: rows.length,
      promoted: delivery.promoted,
      closest: closest.map((c) => c.id),
      resultHash: artifact.sha256,
    }),
  );
} else throw new Error("Expected finalize or verify");
function coverageSymbols() {
  return [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "TRXUSDT",
    "BCHUSDT",
    "ARPAUSDT",
    "MATICUSDT",
    "XRPUSDT",
    "BTTUSDT",
    "WINUSDT",
    "EOSUSDT",
    "LTCUSDT",
    "VETUSDT",
    "ETCUSDT",
    "WAVESUSDT",
    "ATOMUSDT",
    "LINKUSDT",
    "BATUSDT",
    "XTZUSDT",
    "IOSTUSDT",
  ].map((s) => `cx${s}`);
}
process.exit(0);
