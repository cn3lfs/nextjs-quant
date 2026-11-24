import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  alphaExperimentSchema,
  alphaEvaluationInputSchema,
  evaluateAlphaExperiment,
  composeAlphaScores,
  winsorize,
  zScore,
  neutralize,
  targetSnapshotSchema,
  toScheduledTargets,
  type AlphaPanel,
} from "~/lib/research/alpha-experiment";
import {
  evaluateFactor,
  forwardReturn,
  type FactorSeries,
} from "~/lib/research/factor-evaluation";
import {
  runAlphaEvaluation,
  runAlphaTopNBacktest,
} from "~/server/research/alpha";
import { compileFactors, loadAlphaPanel } from "~/server/research/alpha/panel";
import { buildMarketPanel } from "~/server/market/market-panel";
import gbbqFixture from "../fixtures/tdx-gbbq.json";

const days = Array.from({ length: 20 }, (_, i) =>
  new Date(Date.UTC(2024, 7, 1 + i)).toISOString().slice(0, 10),
);
const code = (j: number) => "sh" + String(600000 + j);
let dir: string;
const sources: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quant-alpha-"));
  vi.stubEnv("QUANT_DATA_DIR", join(dir, "data"));
});
afterEach(() => {
  for (const p of sources.splice(0)) chmodSync(p, 0o600);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function source(path: string, data: Buffer) {
  const p = join(dir, "source", path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  chmodSync(p, 0o444);
  sources.push(p);
}
it("T+1 停牌或零价缺失；T+2 仍严格落在复牌当日", () => {
  const series: FactorSeries[] = Array.from({ length: 10 }, (_, j) => ({
    symbol: code(j),
    dates: days.slice(0, 3),
    factor: [j, j, j],
    close: [100, 100 + j, 100 + 2 * j],
  }));
  series[9] = {
    symbol: code(9),
    dates: [days[0]!, days[2]!],
    factor: [9, 9],
    close: [100, 200],
  };
  for (const calendar of [days.slice(0, 3), undefined]) {
    const r = evaluateFactor(series, {
      calendar,
      start: days[0]!,
      end: days[0]!,
      horizons: [1, 2],
      quantiles: 5,
    });
    expect(r.horizons[0]!.groups[0]!.counts.at(-1)).toBe(1);
    expect(r.horizons[0]!.quantileRawMeans.at(-1)).toBeCloseTo(0.08, 12);
    expect(r.horizons[1]!.quantileRawMeans.at(-1)).toBeCloseTo(
      (0.16 + 1) / 2,
      12,
    );
  }
  const noTrade = evaluateFactor(series, {
    calendar: [days[0]!, days[3]!],
    start: days[0]!,
    end: days[0]!,
    horizons: [1],
    quantiles: 5,
  });
  expect(noTrade.horizons[0]!.groups[0]!.returns).toEqual(Array(5).fill(null));
  expect(forwardReturn(10, 0)).toBeNaN();
  expect(forwardReturn(10, undefined)).toBeNaN();
});
it("单因子保留旧 RankIC 分组门槛，Pearson IC 仍报告可用样本", () => {
  const result = evaluateFactor(
    [0, 1, 2].map((j) => ({
      symbol: code(j),
      dates: days.slice(0, 2),
      factor: [j, j],
      close: [10, 10 + j],
    })),
    { start: days[0]!, end: days[0]!, horizons: [1], quantiles: 2 },
  );
  expect(result.skippedDates).toBe(1);
  expect(result.horizons[0]).toMatchObject({ ic: [], icDays: 0 });
  expect(result.horizons[0]!.pearson).toMatchObject({
    days: 1,
    positiveRatio: 1,
  });
  expect(result.horizons[0]!.pearsonIC[0]!.value).toBeCloseTo(1, 12);
});
it("显式日历保留全市场缺档日，T+1 留空且 T+2 对应下一条行情", () => {
  const series = Array.from({ length: 10 }, (_, j) => ({
    symbol: code(j),
    dates: [days[0]!, days[2]!],
    factor: [j, j],
    close: [100, 100 + j],
  }));
  const result = evaluateFactor(series, {
    calendar: days.slice(0, 3),
    start: days[0]!,
    end: days[0]!,
    horizons: [1, 2],
    quantiles: 5,
  });
  expect(result.horizons[0]!.groups[0]).toMatchObject({
    counts: Array(5).fill(0),
    returns: Array(5).fill(null),
  });
  expect(result.horizons[1]!.groups[0]!.returns.at(-1)).toBeCloseTo(0.085, 12);
});
it("MAD、线性分位、零方差及行业与 log(GP16) 联合 OLS 手算", () => {
  const v = [-10, 1, 2, 3, 100, NaN];
  expect([...winsorize(v, "mad", 1)]).toEqual([
    2 - 1.4826,
    1,
    2,
    3,
    2 + 1.4826,
    NaN,
  ]);
  expect([...winsorize(v, "quantile", 3, 0.25)]).toEqual([1, 1, 2, 3, 3, NaN]);
  expect([...zScore([1, 3, NaN])]).toEqual([-1, 1, NaN]);
  expect([...zScore([2, 2, NaN])].every(Number.isNaN)).toBe(true);
  const industry = [1, 1, 1, 2, 2, 2, 0, 1, 2],
    logs = [0, 1, 2, 1, 2, 3, 2, NaN, -Infinity];
  // y = industry intercept + 2 log(cap) + [1,-2,1] in each group.
  const residual = neutralize(
    [11, 10, 15, 23, 22, 27, 999, 555, 666],
    industry,
    logs.map(Math.exp),
    "industry_size",
  );
  const r = [...residual];
  expect(r.slice(0, 6)).toEqual([1, -2, 1, 1, -2, 1]);
  expect(r.slice(6)).toEqual([NaN, NaN, NaN]);
  for (const g of [1, 2])
    expect(
      r.slice(0, 6).reduce((s, x, i) => s + (industry[i] === g ? x : 0), 0),
    ).toBeCloseTo(0, 12);
  expect(r.slice(0, 6).reduce((s, x, i) => s + x * logs[i]!, 0)).toBeCloseTo(
    0,
    12,
  );
});
function market(changeAfter: number): AlphaPanel {
  return {
    panelId: "a".repeat(64),
    calendar: days,
    indexCloses: { sh000906: days.map((_, i) => (i === 7 ? NaN : 100 + i)) },
    securities: Array.from({ length: 12 }, (_, j) => {
      const close: number[] = [100];
      for (let t = 1; t < days.length; t++) {
        const r =
          0.0005 * ((t % 4 === 0 ? -1 : 1) * j + ((j * ((t % 5) + 1)) % 9));
        close.push(close[t - 1]! * (1 + (t > changeAfter ? -0.8 * r : r)));
      }
      return {
        symbol: code(j),
        close,
        amount: days.map(() => 100),
        volume: days.map(() => 100),
        marketCap: days.map(() => (j === 0 ? NaN : 10 + j)),
        industry: days.map(() => (j === 1 ? 0 : 1 + (j % 3))),
        factors: [days.map(() => j), days.map((_, t) => (j * 7 + t) % 12)],
      };
    }),
  };
}
it("市值回归奇异时截面留空，行业间市值差异无法识别行业内斜率", async () => {
  expect([...neutralize([1, 2, 3], [0, 0, 0], [10, 10, 10], "size")]).toEqual([
    NaN,
    NaN,
    NaN,
  ]);
  const panel = market(100);
  const result = await evaluateAlphaExperiment(
    {
      ...panel,
      securities: panel.securities.map((s, j) => ({
        ...s,
        factors: [s.factors[0]!],
        marketCap: days.map(() => (j < 6 ? 10 : 20)),
        industry: days.map(() => (j < 6 ? 1 : 2)),
      })),
    },
    {
      factors: [{ factorId: "momentum" }],
      minTradingDays: 1,
      neutralizationMode: "industry_size",
    },
    { start: days[0]!, end: days[0]! },
  );
  expect(result.daily[0]!.scored).toBe(0);
  expect(result.daily[0]!.singularSizeFactors).toEqual(["momentum"]);
  expect(result.degenerateNeutralizeDays).toBe(1);
  expect(result.targetSnapshot.scheduledTargets[0]!.scores).toEqual({});
});
it("等权反向因子完全抵消时合成截面留空且不选 Top-N", async () => {
  const panel = market(100);
  const result = await evaluateAlphaExperiment(
    {
      ...panel,
      securities: panel.securities.map((s) => ({
        ...s,
        factors: [s.factors[0]!, s.factors[0]!],
      })),
    },
    {
      factors: [
        { factorId: "momentum" },
        { factorId: "reversal", direction: -1 },
      ],
      minTradingDays: 1,
    },
    { start: days[0]!, end: days[0]! },
  );
  expect(result.daily[0]!.scored).toBe(0);
  expect(result.daily[0]!.degenerateComposite).toBe(true);
  expect(result.degenerateCompositeDays).toBe(1);
  expect(result.targetSnapshot.scheduledTargets[0]!.targets).toEqual({});
});
it("修改 t 以后全部价格，非等权的成熟 ICIR 权重、所有合成得分和目标逐位相同", async () => {
  const t = 9;
  const c = alphaExperimentSchema.parse({
    factors: [{ factorId: "momentum" }, { factorId: "amount" }],
    minTradingDays: 1,
    icirHorizon: 2,
    icirWindow: 5,
    icirMinSamples: 3,
    weightingMethod: "icir",
    winsorizeMethod: "none",
    horizons: [1, 2],
  });
  const input = alphaEvaluationInputSchema.parse({
    start: days[0],
    end: days.at(-1),
    targetOptions: { topN: 12, every: 1, maxWeight: 0.1 },
  });
  const a = await evaluateAlphaExperiment(market(100), c, input),
    b = await evaluateAlphaExperiment(market(t), c, input);
  expect(a.daily[0]!.fallbackToEqual).toBe(true);
  expect(a.daily[t]!.fallbackToEqual).toBe(false);
  expect(a.daily[t]!.weights).not.toEqual([0.5, 0.5]);
  expect(a.daily.slice(0, t + 1).map((d) => d.weights)).toEqual(
    b.daily.slice(0, t + 1).map((d) => d.weights),
  );
  expect(
    Object.keys(a.targetSnapshot.scheduledTargets[t]!.scores),
  ).toHaveLength(12);
  expect(a.targetSnapshot.scheduledTargets.slice(0, t + 1)).toEqual(
    b.targetSnapshot.scheduledTargets.slice(0, t + 1),
  );
  expect(a.metrics.horizons[1]!.ic).not.toEqual(b.metrics.horizons[1]!.ic);
  expect(a.daily.slice(t + 2).map((d) => d.weights)).not.toEqual(
    b.daily.slice(t + 2).map((d) => d.weights),
  );
  expect(a.benchmarks).toHaveLength(5);
  expect(a.benchmarks[0]!.horizons[0]!.series[6]!.value).toBeNull();
  expect(a.benchmarks[1]!.horizons[0]!.coverage).toBe(0);
  expect(a.comparisons.map((v) => v.id)).toEqual([
    "selected",
    "original",
    "strict",
    "equal",
    "icir",
  ]);
});
it("自定义权重逐股按可用因子归一化，零权重与全缺失保留缺失", () => {
  const columns = [
    [2, NaN, 6, NaN],
    [6, 8, NaN, NaN],
  ];
  expect([...composeAlphaScores(columns, [0.25, 0.75])]).toEqual([
    5,
    8,
    6,
    NaN,
  ]);
  expect([...composeAlphaScores(columns, [1, 0])]).toEqual([2, NaN, 6, NaN]);
  expect(
    alphaExperimentSchema.safeParse({
      weightingMethod: "custom",
      factors: [{ factorId: "amount", weight: 0 }],
    }).success,
  ).toBe(false);
});
it("资格逐日冻结，未知行业、缺失市值和零成交额各自可核查", async () => {
  const panel = market(100),
    stocks = panel.securities.map((s, i) =>
      i === 2 ? { ...s, amount: days.map((_, t) => (t === 1 ? 0 : 100)) } : s,
    );
  const c = alphaExperimentSchema.parse({
    factors: [{ factorId: "momentum" }, { factorId: "amount" }],
    minTradingDays: 2,
    neutralizationMode: "industry_size",
    liquidityWindow: 2,
    minAverageAmount: 80,
  });
  const a = await evaluateAlphaExperiment(
    { ...panel, securities: stocks },
    c,
    alphaEvaluationInputSchema.parse({ start: days[0], end: days[4] }),
  );
  expect(a.daily[0]!.exclusions.warmup).toBe(12);
  expect(a.daily[1]!.eligible).toBe(11);
  expect(a.daily[1]!.exclusions.invalidAmount).toBe(1);
  expect(a.daily[2]!.exclusions.liquidity).toBe(1);
  expect(a.daily[3]!.eligible).toBe(12);
  expect(a.daily[1]!.missingCap).toBe(1);
  expect(a.daily[1]!.unknownIndustry).toBe(1);
  expect(a.daily[1]!.neutralizationExcluded).toBe(2);
});
it.each(["ZIG(3,5)", "REFX(C,1)"])(
  "批量 Alpha 入口在打开行情前硬拒绝未来函数 %s",
  async (expr) => {
    await expect(
      runAlphaEvaluation({
        root: join(dir, "absent"),
        now: Date.now(),
        input: { start: days[0]!, end: days[1]! },
        config: { factors: [{ factorId: "test", formula: "X:" + expr + ";" }] },
      }),
    ).rejects.toThrow(/未来|因果/);
  },
);
function dayFile(
  dates: readonly string[],
  amounts: (d: string) => number,
  volumes: (d: string) => number,
  prices: (d: string) => number = () => 1000,
) {
  const bytes = Buffer.alloc(32 * dates.length);
  dates.forEach((d, i) => {
    const at = i * 32;
    bytes.writeUInt32LE(Number(d.replaceAll("-", "")), at);
    const close = prices(d);
    [close, close + 20, close - 20, close].forEach((p, k) =>
      bytes.writeUInt32LE(p, at + 4 + 4 * k),
    );
    bytes.writeFloatLE(amounts(d), at + 20);
    bytes.writeUInt32LE(volumes(d), at + 24);
  });
  return bytes;
}
function dailySource(suspendAfterFirst = false) {
  const dates = ["2024-08-01", "2024-08-02", "2024-08-05", "2024-08-06"];
  // The risk policy's Wilder ATR(14) needs completed sessions preceding the replay.
  const warm = Array.from(
    { length: 26 },
    (_, i) => new Date(Date.UTC(2024, 6, i + 1)),
  )
    .filter((d) => d.getUTCDay() % 6 !== 0)
    .map((d) => d.toISOString().slice(0, 10));
  const history = [...warm, ...dates];
  source("T0002/hq_cache/gbbq", Buffer.alloc(4));
  for (let j = 0; j < 2; j++) {
    source(
      "vipdoc/sh/lday/" + code(j) + ".day",
      dayFile(
        history,
        (d) => ((d === dates[0]) === (j === 0) ? 20_000_000 : 10_000_000),
        (d) => (suspendAfterFirst && j === 0 && d === dates[1] ? 0 : 2_000_000),
      ),
    );
  }
  return { root: join(dir, "source"), dates };
}
it.each(["sh000300", "sz399001", null])(
  "单因子任务使用指数 %s 或披露个股并集回退",
  async (index) => {
    vi.resetModules();
    const { evaluateFactorWork } =
      await import("~/server/research/factor-evaluation-job");
    const { sqlite } = await import("~/server/db");
    const sessions = ["2024-08-01", "2024-08-02", "2024-08-05"];
    for (let j = 0; j < 10; j++)
      source(
        `vipdoc/sh/lday/${code(j)}.day`,
        dayFile(
          [sessions[0]!, sessions[2]!],
          () => 100_000 + j,
          () => 1000,
          (d) => (d === sessions[0] ? 1000 : 1000 + j),
        ),
      );
    if (index)
      source(
        `vipdoc/${index.slice(0, 2)}/lday/${index}.day`,
        dayFile(
          sessions,
          () => 100_000,
          () => 1000,
        ),
      );
    try {
      const result = await evaluateFactorWork({
        type: "factor-eval",
        root: join(dir, "source"),
        now: Date.parse("2024-08-07"),
        source: "X:AMOUNT;",
        start: sessions[0]!,
        end: sessions[0]!,
        parameters: {},
        horizons: [1, 2],
        quantiles: 5,
      });
      expect(result.calendarSource).toBe(index ? "index" : "security-union");
      expect(result.calendarIndex).toBe(index);
      const [t1, t2] = result.horizons;
      if (index) {
        expect(result.calendarWarnings).toEqual([]);
        expect(t1!.groups[0]!.returns).toEqual(Array(5).fill(null));
        expect(t2!.groups[0]!.returns.at(-1)).toBeCloseTo(0.0085, 12);
      } else {
        expect(result.basis).toContain("全市场缺档日可能被跳过");
        expect(result.calendarWarnings).toHaveLength(1);
        expect(t1!.groups[0]!.returns.at(-1)).toBeCloseTo(0.0085, 12);
      }
    } finally {
      sqlite().close();
      vi.resetModules();
    }
  },
);
it("Alpha 冻结及回放指数日历，保留全体缺档日并忽略指数外股票日期", async () => {
  const dates = ["2024-08-01", "2024-08-02", "2024-08-06"];
  const stockDates = [dates[0]!, "2024-08-05", dates[2]!];
  source("T0002/hq_cache/gbbq", Buffer.alloc(4));
  source(
    "vipdoc/sh/lday/sh000001.day",
    dayFile(
      dates,
      () => 100_000,
      () => 1000,
    ),
  );
  for (let j = 0; j < 2; j++)
    source(
      `vipdoc/sh/lday/${code(j)}.day`,
      dayFile(
        stockDates,
        () => 100_000 + j,
        () => 1000,
      ),
    );
  const root = join(dir, "source");
  const result = await runAlphaEvaluation({
    root,
    now: Date.parse("2024-08-07"),
    input: { start: dates[0]!, end: dates[2]!, targetOptions: { every: 2 } },
    config: { factors: [{ factorId: "amount" }], minTradingDays: 1 },
  });
  expect(result.metadata.calendarSource).toBe("index");
  expect(result.daily.map(({ date, eligible }) => [date, eligible])).toEqual([
    [dates[0], 2],
    [dates[1], 0],
    [dates[2], 2],
  ]);
  const snapshot = targetSnapshotSchema.parse(
    JSON.parse(JSON.stringify(result.targetSnapshot)),
  );
  expect(snapshot.calendarIndex).toBe("sh000001");
  expect(snapshot.config).toEqual(result.config);
  expect(snapshot.scheduledTargets.map(({ date }) => date)).toEqual([
    dates[0],
    dates[2],
  ]);
  const replay = await runAlphaTopNBacktest({ root, snapshot });
  expect(replay.portfolio.equity.map(({ date }) => date)).toEqual(dates);
  expect(replay.portfolio.fills).toEqual([]);
  expect(replay.portfolio.rejections[0]?.date).toBe(dates[1]);
});
it("多指数日历并集保留单指数缺失的交易日", async () => {
  const dates = ["2024-08-01", "2024-08-02", "2024-08-05", "2024-08-06"];
  source("T0002/hq_cache/gbbq", Buffer.alloc(4));
  // sh000001 lacks 2024-08-02 while sh000300 records it; index-union preserves it.
  source(
    "vipdoc/sh/lday/sh000001.day",
    dayFile(
      ["2024-08-01", "2024-08-05", "2024-08-06"],
      () => 100_000,
      () => 1000,
    ),
  );
  source(
    "vipdoc/sh/lday/sh000300.day",
    dayFile(
      dates,
      () => 100_000,
      () => 1000,
    ),
  );
  for (let j = 0; j < 2; j++)
    source(
      `vipdoc/sh/lday/${code(j)}.day`,
      dayFile(
        ["2024-08-01", "2024-08-05", "2024-08-06"],
        () => 100_000 + j,
        () => 1000,
      ),
    );
  const root = join(dir, "source");
  const merged = await runAlphaEvaluation({
    root,
    now: Date.parse("2024-08-07"),
    input: { start: dates[0]!, end: dates[3]!, targetOptions: { every: 2 } },
    config: { factors: [{ factorId: "amount" }], minTradingDays: 1 },
  });
  expect(merged.targetSnapshot.calendarIndex).toBe("index-union");
  expect(merged.daily.map(({ date, eligible }) => [date, eligible])).toEqual([
    ["2024-08-01", 2],
    ["2024-08-02", 0],
    ["2024-08-05", 2],
    ["2024-08-06", 2],
  ]);
});
it("换手率仅从 GBBQ 流通股本的生效日开始可用，缺记录留空", async () => {
  const calendar = ["1991-04-01", "1991-04-02", "1991-04-03", "1991-04-04"];
  const quotes = dayFile(
    calendar,
    () => 20_000_000,
    () => 2_000_000,
  );
  source("vipdoc/sz/lday/sz000001.day", quotes);
  source("vipdoc/sh/lday/sh600000.day", quotes);
  source("T0002/hq_cache/gbbq", Buffer.from(gbbqFixture.gbbqBase64, "base64"));
  const handle = await buildMarketPanel(join(dir, "source"));
  try {
    const config = alphaExperimentSchema.parse({
      factors: [{ factorId: "turnover" }],
    });
    const input = alphaEvaluationInputSchema.parse({
      start: calendar[0],
      end: calendar.at(-1),
    });
    const panel = loadAlphaPanel(
      handle,
      input,
      config,
      compileFactors(config),
      Date.parse("1991-04-05"),
    );
    const shares = 26_500_000;
    expect(
      Array.from(
        panel.securities.find((s) => s.symbol === "sz000001")!.factors[0]!,
      ),
    ).toEqual([NaN, NaN, 2_000_000 / shares, 2_000_000 / shares]);
    expect(
      Array.from(
        panel.securities.find((s) => s.symbol === "sh600000")!.factors[0]!,
      ),
    ).toEqual(Array(4).fill(NaN));
  } finally {
    handle.close();
  }
});

it("公式 RPS 使用市场 t−3 端点，停牌股票不进入当日排名", async () => {
  const calendar = [
    "2024-08-01",
    "2024-08-02",
    "2024-08-05",
    "2024-08-06",
    "2024-08-07",
  ];
  source("T0002/hq_cache/gbbq", Buffer.alloc(4));
  for (let j = 0; j < 3; j++)
    source(
      `vipdoc/sh/lday/${code(j)}.day`,
      dayFile(
        calendar,
        () => 20_000_000,
        (date) => (j === 2 && date === calendar[1] ? 0 : 2_000_000),
        (date) => 1000 + j * 20 * Math.max(0, calendar.indexOf(date) - 2),
      ),
    );
  const handle = await buildMarketPanel(join(dir, "source"));
  try {
    const config = alphaExperimentSchema.parse({
      factors: [{ factorId: "rps", formula: "X:RPS3;" }],
    });
    const input = alphaEvaluationInputSchema.parse({
      start: calendar[0],
      end: calendar.at(-1),
    });
    const panel = loadAlphaPanel(
      handle,
      input,
      config,
      compileFactors(config),
      Date.parse("2024-08-08"),
    );
    const values = panel.securities.map(({ factors }) =>
      Array.from(factors[0]!),
    );
    expect(values.map((col) => col.slice(0, 3))).toEqual(
      Array.from({ length: 3 }, () => [NaN, NaN, NaN]),
    );
    expect(values.map((col) => col[3])).toEqual([
      0,
      (1 - 2 / 3) * 100,
      (1 - 1 / 3) * 100,
    ]);
    expect(values.map((col) => col[4])).toEqual([0, 50, NaN]);
  } finally {
    handle.close();
  }
});
it("只读日线 → 公式 → 冻结 Top-N → 次日开盘买入、T+1 卖出及双倍历史费税", async () => {
  const { root, dates } = dailySource();
  const result = await runAlphaEvaluation({
    root,
    now: Date.parse("2024-08-07"),
    input: {
      start: dates[0]!,
      end: dates.at(-1)!,
      targetOptions: { topN: 1, every: 1, maxWeight: 0.1 },
    },
    config: {
      minTradingDays: 1,
      factors: [{ factorId: "liquidity", formula: "X:AMOUNT;" }],
    },
  });
  const snapshot = result.targetSnapshot;
  expect(Object.keys(snapshot.scheduledTargets[0]!.targets)).toEqual([code(0)]);
  expect(snapshot.scheduledTargets[0]!.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  expect(await toScheduledTargets(snapshot)).toEqual(snapshot.scheduledTargets);
  const tampered = structuredClone(snapshot);
  tampered.scheduledTargets[0]!.scores[code(0)] = 99;
  await expect(
    runAlphaTopNBacktest({ root, snapshot: tampered }),
  ).rejects.toThrow(/摘要/);
  for (const costScenario of ["base", "double-cost"] as const) {
    const backtest = await runAlphaTopNBacktest({
      root,
      snapshot,
      initial: 100_000,
      costScenario,
      ...(costScenario === "double-cost"
        ? { riskPolicy: { maxIndustryWeight: 1 } }
        : {}),
    });
    if (costScenario === "double-cost")
      expect(backtest.portfolio.riskAudit?.daily.length).toBeGreaterThan(0);
    const fills = backtest.portfolio.fills.filter((f) => f.symbol === code(0));
    if (costScenario === "base") expect(fills[0]?.price).toBe(10.01);
    expect(fills.map((f) => [f.side, f.signalAt, f.date])).toEqual([
      ["buy", dates[0], dates[1]],
      ["sell", dates[1], dates[2]],
    ]);
    expect(fills[1]!.quantity).toBe(fills[0]!.quantity);
    for (const fill of fills) {
      const amount = fill.price * fill.quantity;
      const handFee =
        Math.max(5, amount * 0.0003) +
        amount * 0.00001 +
        (fill.side === "sell" ? amount * 0.0005 : 0);
      expect(fill.fee).toBeCloseTo(
        handFee * (costScenario === "base" ? 1 : 2),
        2,
      );
    }
    expect(backtest.metrics.totalReturn).toBeLessThan(0);
  }
});

it("下一交易日停牌时，冻结买入遵循组合引擎拒单规则", async () => {
  const { root, dates } = dailySource(true);
  const { targetSnapshot } = await runAlphaEvaluation({
    root,
    now: Date.parse("2024-08-07"),
    input: {
      start: dates[0]!,
      end: dates.at(-1)!,
      targetOptions: { topN: 1, every: 3 },
    },
    config: { factors: [{ factorId: "amount" }], minTradingDays: 1 },
  });
  const result = await runAlphaTopNBacktest({ root, snapshot: targetSnapshot });
  expect(result.portfolio.fills).toHaveLength(0);
  expect(result.portfolio.orders[0]).toMatchObject({
    symbol: code(0),
    signalAt: dates[0],
    due: dates[1],
    status: "rejected",
  });
  expect(result.portfolio.rejections[0]?.date).toBe(dates[1]);
});

it("默认 Alpha 回测对科创板执行 200 股起申报、逐股递增", async () => {
  const dates = ["2024-08-01", "2024-08-02"];
  const star = "sh688001";
  source("T0002/hq_cache/gbbq", Buffer.alloc(4));
  source(
    `vipdoc/sh/lday/${star}.day`,
    dayFile(
      dates,
      () => 200_000,
      () => 1000,
    ),
  );
  source(
    `vipdoc/sh/lday/${code(0)}.day`,
    dayFile(
      dates,
      () => 100_000,
      () => 1000,
    ),
  );
  const root = join(dir, "source");
  const { targetSnapshot } = await runAlphaEvaluation({
    root,
    now: Date.parse("2024-08-05"),
    input: {
      start: dates[0]!,
      end: dates[1]!,
      targetOptions: { topN: 1, maxWeight: 1 },
    },
    config: { factors: [{ factorId: "amount" }], minTradingDays: 1 },
  });
  const admitted = await runAlphaTopNBacktest({
    root,
    snapshot: targetSnapshot,
    initial: 2020,
  });
  expect(admitted.portfolio.fills).toMatchObject([
    { symbol: star, side: "buy", quantity: 201, price: 10.01 },
  ]);
  const rejected = await runAlphaTopNBacktest({
    root,
    snapshot: targetSnapshot,
    initial: 1999,
  });
  expect(rejected.portfolio.fills).toEqual([]);
  expect(rejected.portfolio.rejections).toHaveLength(1);
});

it("预热未完成的空目标保留完整交易日现金曲线", async () => {
  const { root, dates } = dailySource();
  const { targetSnapshot } = await runAlphaEvaluation({
    root,
    now: Date.parse("2024-08-07"),
    input: { start: dates[0]!, end: dates.at(-1)! },
    config: { factors: [{ factorId: "amount" }] },
  });
  expect(targetSnapshot.scheduledTargets[0]!.targets).toEqual({});
  const result = await runAlphaTopNBacktest({ root, snapshot: targetSnapshot });
  expect(result.portfolio.orders).toHaveLength(0);
  expect(
    result.portfolio.equity.map(({ date, equity }) => [date, equity]),
  ).toEqual(dates.map((date) => [date, 1_000_000]));
});

it("真实 tRPC 和 worker 完成两段任务；评估排队后更改配置会阻止旧摘要写回", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const { Worker } = await import("node:worker_threads");
  const { researchRouter } = await import("~/server/api/routers/research");
  const { settings, saveSettings } = await import("~/server/infra/settings");
  const { sqlite } = await import("~/server/db");
  const { readJob } = await import("~/server/db/jobs");
  const { z } = await import("zod");
  const { root, dates } = dailySource();
  const runtime = join(dir, "runtime");
  const resolveModule = createRequire(import.meta.url).resolve;
  await build({
    entryPoints: ["src/server/jobs/worker.ts"],
    outfile: join(runtime, "worker.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    plugins: [
      {
        name: "test-native-module",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: resolveModule("better-sqlite3"),
            external: true,
          }));
        },
      },
    ],
  });
  vi.stubEnv("QUANT_WORKER_DIR", runtime);
  const workers: InstanceType<typeof Worker>[] = [];
  const construct = Reflect.construct,
    track = vi
      .spyOn(Reflect, "construct")
      .mockImplementation((target, args, newTarget) => {
        const value = construct(target, args, newTarget ?? target);
        if (target === Worker)
          workers.push(value as InstanceType<typeof Worker>);
        return value;
      });
  const caller = researchRouter.createCaller({ headers: new Headers() });
  const id = "saved-alpha",
    input = {
      start: dates[0]!,
      end: dates.at(-1)!,
      targetOptions: { topN: 1, every: 1 },
    };
  const saved = {
    id,
    name: "测试合成",
    weightingMethod: "equal" as const,
    neutralizationMode: "none" as const,
    winsorizeMethod: "none" as const,
    config: {
      factors: [{ factorId: "amount", direction: 1 as const }],
      parameters: { minTradingDays: 1 },
    },
  };
  async function completed(jobId: string) {
    return vi.waitFor(
      () => {
        const job = readJob(jobId);
        if (job?.status === "failed") throw Error(job.error ?? "worker 失败");
        expect(job?.status).toBe("completed");
        return job!.result;
      },
      { timeout: 10000, interval: 30 },
    );
  }
  try {
    saveSettings({ ...settings(), tdxRoot: root });
    const first = await caller.alphaCompositeSave(saved);
    expect(
      (await caller.alphaComposites({ limit: 1 })).items.map((x) => x.id),
    ).toEqual([id]);
    const old = await caller.alphaEvaluate({ compositeId: id, input });
    await caller.alphaCompositeSave({
      ...saved,
      config: {
        ...saved.config,
        factors: [{ factorId: "amount", direction: -1 }],
      },
    });
    expect(await completed(old.id)).toMatchObject({ summaryUpdated: false });
    expect(
      (await caller.alphaCompositeGet({ id }))?.latestEvalSummary,
    ).toBeNull();
    const current = await caller.alphaEvaluate({ compositeId: id, input });
    const result = z
      .object({
        summaryUpdated: z.literal(true),
        targetSnapshot: targetSnapshotSchema,
      })
      .parse(await completed(current.id));
    const latest = await caller.alphaCompositeGet({ id });
    expect(latest?.configHash).not.toBe(first.configHash);
    expect(latest?.latestEvalSummary).not.toBeNull();
    const replay = await caller.alphaBacktest({
      snapshot: result.targetSnapshot,
    });
    expect(await completed(replay.id)).toMatchObject({
      panelId: result.targetSnapshot.panelId,
      metrics: { observations: 4 },
    });
    expect(await caller.alphaCompositeDelete({ id })).toBe(true);
    expect(await caller.alphaCompositeGet({ id })).toBeNull();
  } finally {
    track.mockRestore();
    await Promise.all(workers.map((w) => w.terminate()));
    sqlite().close();
  }
}, 30000);
it("内置价量公式因子 momentum/reversal/volatility 均使用合法 N1 参数且可编译求值", async () => {
  const { compileFactors } = await import("~/server/research/alpha/panel");
  const { alphaExperimentSchema } =
    await import("~/lib/research/alpha-experiment");
  const compiled = compileFactors(
    alphaExperimentSchema.parse({
      factors: [
        { factorId: "momentum", direction: 1 },
        { factorId: "reversal", direction: 1, parameters: { N: 5 } },
        { factorId: "volatility", direction: -1, parameters: { N1: 10 } },
        { factorId: "turnover", direction: -1 },
        { factorId: "amount", direction: 1 },
      ],
    }),
  );
  expect(compiled).toHaveLength(5);
  expect(typeof compiled[0]).toBe("object");
  expect(typeof compiled[1]).toBe("object");
  expect(typeof compiled[2]).toBe("object");
  expect(compiled[3]).toBe("turnover");
  expect(compiled[4]).toBe("amount");
});
