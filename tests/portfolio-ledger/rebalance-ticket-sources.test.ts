import { beforeAll, expect, it, vi } from "vitest";
import {
  etfRotationCatalog,
  etfRotationUniverseFor,
  etfSectorRotation,
  generateEtfRotationTargets,
} from "trading-strategies";
import { createTargetSnapshot } from "~/lib/research/alpha-experiment";
import { put, putChangedBatch, sqlite } from "~/server/db";
import { PaperRepository } from "~/server/db/paper-repository";
import { settings } from "~/server/infra/settings";
import type { PaperAccount } from "~/server/paper/model";
import {
  rebalanceSourceSchema,
  resolveRebalanceTargets,
} from "~/server/paper/rebalance-targets";
import { listRebalanceTicketSources } from "~/server/paper/ticket-source-catalog";
import { loadAccountBook } from "~/server/portfolio/account-workspace/load-book";
import * as etfMarket from "~/server/research/etf-rotation/market-data";
import * as valuePit from "~/server/research/value-pit-service";

const day = "2024-04-30";
const strategyId = "etf-risk-budget" as const;
const preset = { kind: "etf_rotation_preset", strategyId } as const;
const pairs = [
  { pairId: "hs300-zz500", legA: "sh510300", legB: "sh510500" },
  { pairId: "dividend-chinext", legA: "sh510880", legB: "sz159915" },
  { pairId: "gold-treasury", legA: "sh518880", legB: "sh511010" },
] as const;
const macroPreset = { kind: "macro_clock_preset" } as const;
const pairPreset = {
  kind: "pair_switch_preset",
  pairId: pairs[0].pairId,
} as const;
const stock = "sh600000";
const macroPreview = {
  strategyId: "macro-clock-etf-rotation" as const,
  date: day,
  availableAt: day,
  sourceHash: "c".repeat(64),
  regime: "recovery" as const,
  targets: { sh510300: 0.4, sz159915: 0.4, sh510880: 0.2 },
  scores: { pmiChange: 0.3, inflationChange: -0.1, termSpread: 0.2 },
  disclosure: "fixture",
};
const pairPreview = {
  strategyId: "stat-pair-switch-zscore" as const,
  pairId: "hs300-zz500" as const,
  date: day,
  availableAt: day,
  sourceHash: "d".repeat(64),
  status: "ok" as const,
  zScore: -2.1,
  beta: 0.9,
  correlation: 0.8,
  activeLeg: "A" as const,
  targets: { sh510300: 1, sh510500: 0 },
  scores: { sh510300: 2.1, sh510500: -2.1 },
  disclosure: "fixture",
};
let snapshot: Awaited<ReturnType<typeof createTargetSnapshot>>;
let book: Awaited<ReturnType<typeof loadAccountBook>>;

beforeAll(async () => {
  snapshot = await createTargetSnapshot(
    "a".repeat(64),
    { start: day, end: "2024-05-10" },
    [{ date: day, scores: [{ symbol: stock, score: 4 }] }],
  );
  book = await loadAccountBook(
    undefined,
    { ...settings(), tdxRoot: "fixture", industryBlocksRoot: "" },
    Date.parse(day),
    {
      localOnly: true,
      bars: {},
      context: {
        calendar: [day],
        calendarSource: "fixture",
        today: day,
        evidence: () => ({ events: [], coverageEnd: day, source: "fixture" }),
      },
    },
  );
  for (const [id, type, status, result] of [
    ["alpha-ready", "factor-eval", "completed", { targetSnapshot: snapshot }],
    ["research-ready", "research", "completed", { targetSnapshot: snapshot }],
    ["unfinished", "factor-eval", "running", { targetSnapshot: snapshot }],
    ["no-snapshot", "factor-eval", "completed", {}],
    ["invalid-snapshot", "research", "completed", { targetSnapshot: {} }],
    ["other-kind", "scan", "completed", { targetSnapshot: snapshot }],
  ] as const) {
    put("job", id, {
      id,
      type,
      status,
      result,
      input: { mode: "alpha-composite" },
      createdAt: 1,
      updatedAt: 2,
      progress: 1,
    });
  }
  const paper = new PaperRepository();
  const account: PaperAccount = {
    id: "cny",
    name: "纸面组合",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "main",
    candidates: [],
    startedAt: 1,
    initial: 100000,
    mirror: { venue: "off" },
    mirrorRevision: "1",
    revision: 1,
    lastBar: day,
    lastRun: null,
    error: null,
    summary: null,
  };
  paper.create(account);
  paper.create({
    ...account,
    id: "usdt",
    market: "crypto",
    currency: "USDT",
  });
});

it("accepts the six source variants and rejects extra fields on every variant", () => {
  for (const source of [
    { kind: "manual", sourceRefId: "manual", targets: {} },
    { kind: "alpha", snapshot },
    { kind: "alpha_job", jobId: "alpha-ready" },
    {
      kind: "etf_rotation",
      snapshot: {
        strategyId,
        date: day,
        availableAt: day,
        targets: {},
        scores: {},
        sourceHash: "b".repeat(64),
      },
    },
    preset,
    { kind: "studio", paperAccountId: "cny", strategyId: "studio" },
  ]) {
    expect(rebalanceSourceSchema.safeParse(source).success).toBe(true);
    expect(
      rebalanceSourceSchema.safeParse({ ...source, extra: true }).success,
    ).toBe(false);
  }
  expect(rebalanceSourceSchema.safeParse({ kind: "unknown" }).success).toBe(
    false,
  );
});

it("lists presets, usable job snapshots and CNY paper accounts without a ledger write", () => {
  const changes = sqlite().prepare("SELECT total_changes()").pluck();
  const before = changes.get();
  const sources = listRebalanceTicketSources({ asOfDate: day });
  expect(sources.etfPresets).toEqual(etfRotationCatalog);
  expect(sources.etfPresets).toHaveLength(3);
  expect(sources.alphaJobs.map((job) => job.id).sort()).toEqual([
    "alpha-ready",
    "research-ready",
  ]);
  expect(sources.paperAccounts).toEqual([
    { id: "cny", name: "纸面组合", lastBar: day },
  ]);
  expect(
    listRebalanceTicketSources({ asOfDate: "2024-05-06" }).alphaJobs,
  ).toEqual([]);
  expect(listRebalanceTicketSources().alphaJobs).toHaveLength(2);
  expect(changes.get()).toEqual(before);
});

it("finds matching Alpha jobs behind newer unrelated and wrong-date jobs", async () => {
  const otherDate = "2024-05-06";
  const otherSnapshot = await createTargetSnapshot(
    "a".repeat(64),
    { start: otherDate, end: otherDate },
    [{ date: otherDate, scores: [{ symbol: stock, score: 4 }] }],
  );
  try {
    putChangedBatch(
      "job",
      Array.from({ length: 102 }, (_, index) => ({
        id: `catalog-crowd-${index}`,
        type: index < 21 ? "factor-eval" : "scan",
        status: "completed",
        createdAt: 3,
        updatedAt: 3,
        result: { targetSnapshot: otherSnapshot },
      })),
    );
    expect(
      listRebalanceTicketSources({ asOfDate: day })
        .alphaJobs.map((job) => job.id)
        .sort(),
    ).toEqual(["alpha-ready", "research-ready"]);
    expect(
      listRebalanceTicketSources({ asOfDate: otherDate }).alphaJobs,
    ).toHaveLength(20);
  } finally {
    sqlite()
      .prepare(
        "DELETE FROM records WHERE kind='job' AND id LIKE 'catalog-crowd-%'",
      )
      .run();
  }
});

it("freezes a completed Alpha job identically to importing its verified snapshot", async () => {
  const job = { kind: "alpha_job", jobId: "alpha-ready" } as const;
  const allocation = await resolveRebalanceTargets(job, day, book);
  expect(allocation).toMatchObject({
    sourceKind: "alpha",
    targets: { [stock]: 0.1 },
  });
  expect(allocation).toEqual(
    await resolveRebalanceTargets({ kind: "alpha", snapshot }, day, book),
  );
  await expect(
    resolveRebalanceTargets(job, "2024-05-06", book),
  ).rejects.toThrow("决策日");
  for (const jobId of [
    "missing",
    "unfinished",
    "other-kind",
    "invalid-snapshot",
    "no-snapshot",
  ])
    await expect(
      resolveRebalanceTargets({ ...job, jobId }, day, book),
    ).rejects.toThrow("Alpha");
  put("job", "tampered", {
    id: "tampered",
    type: "factor-eval",
    status: "completed",
    result: { targetSnapshot: { ...snapshot, snapshotHash: "0".repeat(64) } },
  });
  try {
    await expect(
      resolveRebalanceTargets({ ...job, jobId: "tampered" }, day, book),
    ).rejects.toThrow("摘要");
  } finally {
    sqlite()
      .prepare("DELETE FROM records WHERE kind='job' AND id='tampered'")
      .run();
  }
});

it("freezes only a completed month-end ETF signal with full lookback evidence", async () => {
  const calendar: string[] = [];
  for (
    let at = Date.parse("2024-01-02");
    at <= Date.parse(day);
    at += 86400000
  ) {
    const d = new Date(at);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      calendar.push(d.toISOString().slice(0, 10));
  }
  const bars = calendar.map((date, i) => {
    const price = 100 + (i % 2);
    return {
      date,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 100,
      amount: 10000,
    };
  });
  const market = {
    calendar: [...calendar, "2024-05-06"],
    calendarBasis: "fixture",
    actionsSource: "fixture",
    series: Object.fromEntries(
      ["sh510300", "sh511010", "sh518880"].map(
        (symbol) => [symbol, { bars, events: [] }] as const,
      ),
    ),
  };
  const loader = vi
    .spyOn(etfMarket, "loadEtfRotationMarketData")
    .mockResolvedValue(market);
  try {
    await expect(
      resolveRebalanceTargets(preset, "2024-02-30", book),
    ).rejects.toThrow("决策日");
    await expect(
      resolveRebalanceTargets(preset, "2999-04-30", book),
    ).rejects.toThrow("尚未收盘");
    expect(loader).not.toHaveBeenCalled();
    const allocation = await resolveRebalanceTargets(preset, day, book);
    expect(allocation.sourceKind).toBe("etf_rotation");
    expect(allocation.sourceRefId).toContain(strategyId);
    for (const symbol of Object.keys(market.series))
      expect(allocation.targets[symbol]).toBeCloseTo(1 / 3);
    expect(loader).toHaveBeenCalledWith(
      { kind: "tdx", root: "fixture" },
      expect.any(Array),
      day,
    );
    await expect(
      resolveRebalanceTargets(preset, "2024-04-29", book),
    ).rejects.toThrow("月末");
    loader.mockResolvedValue({ ...market, calendar });
    await expect(resolveRebalanceTargets(preset, day, book)).rejects.toThrow(
      "月末",
    );
    expect(
      await resolveRebalanceTargets(preset, day, {
        ...book,
        calendar: [day, "2024-05-06"],
      }),
    ).toEqual(allocation);
    loader.mockResolvedValue({
      ...market,
      series: {
        ...market.series,
        sh510300: {
          bars: bars.filter((_, index) => index !== bars.length - 2),
          events: [],
        },
      },
    });
    await expect(resolveRebalanceTargets(preset, day, book)).rejects.toThrow(
      "回看行情不完整",
    );
  } finally {
    loader.mockRestore();
  }
});

it("skips pre-listing sector windows but rejects a gap after the universe is active", async () => {
  const defaults = etfSectorRotation.defaults;
  const universe = etfRotationUniverseFor(defaults);
  const missingSymbol = universe.find(
    (etf) => etf.assetClass === "sector",
  )!.symbol;
  const calendar = Array.from({ length: 305 }, (_, index) => {
    const date = new Date(Date.UTC(2023, 6, index + 1));
    return date.getUTCDay() % 6 ? date.toISOString().slice(0, 10) : null;
  }).filter((date) => date !== null);
  calendar.push("2024-05-06");
  const bars = calendar.slice(0, -1).map((date, index) => {
    const price = 100 + index;
    return {
      date,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 100,
      amount: 10000,
    };
  });
  const series = Object.fromEntries(
    universe.map(({ symbol }) => [
      symbol,
      {
        bars:
          symbol === missingSymbol
            ? bars.filter((bar) => bar.date >= "2023-09-01")
            : bars,
        events: [],
      },
    ]),
  );
  const schedule = await generateEtfRotationTargets(defaults, {
    calendar,
    start: "2023-09-29",
    end: day,
    closes: Object.fromEntries(
      Object.entries(series).map(([symbol, source]) => [symbol, source.bars]),
    ),
    priceBasis: "gbbq-first-raw-anchor-1",
    universe,
  });
  expect(schedule.snapshots[0]?.evidence.rows).toContainEqual(
    expect.objectContaining({
      symbol: missingSymbol,
      reason: "missing-history",
    }),
  );
  expect(schedule.snapshots.at(-1)?.evidence.rows).toContainEqual(
    expect.objectContaining({
      symbol: missingSymbol,
      rank: expect.any(Number),
    }),
  );
  const market = {
    calendar,
    calendarBasis: "fixture",
    actionsSource: "fixture",
    series,
  };
  const source = { ...preset, strategyId: etfSectorRotation.id };
  const loader = vi
    .spyOn(etfMarket, "loadEtfRotationMarketData")
    .mockResolvedValue(market);
  try {
    await expect(
      resolveRebalanceTargets(source, day, book),
    ).resolves.toMatchObject({
      sourceKind: "etf_rotation",
    });
    const active = series[missingSymbol]!;
    loader.mockResolvedValue({
      ...market,
      series: {
        ...series,
        [missingSymbol]: {
          ...active,
          bars: active.bars.filter((bar) => bar.date !== "2024-01-10"),
        },
      },
    });
    await expect(resolveRebalanceTargets(source, day, book)).rejects.toThrow(
      "回看行情不完整（2024-01-31）",
    );
  } finally {
    loader.mockRestore();
  }
});

it("accepts macro clock and pair switch presets and rejects extra or unknown fields", () => {
  for (const source of [
    macroPreset,
    ...pairs.map(({ pairId }) => ({ kind: "pair_switch_preset", pairId })),
  ]) {
    expect(rebalanceSourceSchema.safeParse(source).success).toBe(true);
    expect(
      rebalanceSourceSchema.safeParse({ ...source, extra: true }).success,
    ).toBe(false);
  }
  expect(
    rebalanceSourceSchema.safeParse({
      kind: "pair_switch_preset",
      pairId: "other",
    }).success,
  ).toBe(false);
  expect(
    rebalanceSourceSchema.safeParse({ kind: "pair_switch_preset" }).success,
  ).toBe(false);
  expect(
    rebalanceSourceSchema.safeParse({
      kind: "macro_clock_preset",
      asOfDate: day,
    }).success,
  ).toBe(false);
});

it("normalizes a valid macro clock preview into a frozen etf_rotation allocation", async () => {
  const spy = vi
    .spyOn(valuePit, "previewMacroClockAllocation")
    .mockReturnValue(macroPreview);
  try {
    const allocation = await resolveRebalanceTargets(macroPreset, day, book);
    expect(spy).toHaveBeenCalledWith({ asOfDate: day });
    expect(allocation).toEqual({
      sourceKind: "etf_rotation",
      asOfDate: day,
      targets: macroPreview.targets,
      scores: {},
      sourceRefId: expect.stringMatching(
        /^macro-clock-etf-rotation\/recovery\/c{64}#[a-f0-9]{64}$/,
      ),
    });
  } finally {
    spy.mockRestore();
  }
});

it("fails closed when the macro clock regime is unknown or has no targets", async () => {
  const spy = vi.spyOn(valuePit, "previewMacroClockAllocation");
  try {
    spy.mockReturnValue({ ...macroPreview, regime: "unknown" });
    await expect(
      resolveRebalanceTargets(macroPreset, day, book),
    ).rejects.toThrow("宏观时钟");
    spy.mockReturnValue({ ...macroPreview, targets: {} });
    await expect(
      resolveRebalanceTargets(macroPreset, day, book),
    ).rejects.toThrow("宏观时钟");
  } finally {
    spy.mockRestore();
  }
});

it.each(pairs)(
  "normalizes the $pairId pair into a frozen etf_rotation allocation",
  async ({ pairId, legA, legB }) => {
    const targets = { [legA]: 1, [legB]: 0 };
    const scores = { [legA]: 2.1, [legB]: -2.1 };
    const spy = vi
      .spyOn(valuePit, "previewPairSwitchAllocation")
      .mockResolvedValue({
        ...pairPreview,
        pairId,
        targets,
        scores,
      });
    try {
      const allocation = await resolveRebalanceTargets(
        { kind: "pair_switch_preset", pairId },
        day,
        book,
      );
      expect(spy).toHaveBeenCalledWith({
        pairId,
        asOfDate: day,
        tdxRoot: "fixture",
      });
      expect(allocation).toMatchObject({
        sourceKind: "etf_rotation",
        asOfDate: day,
        targets,
        scores,
      });
      expect(allocation.sourceRefId).toMatch(
        new RegExp(`^stat-pair-switch-zscore/${pairId}/d{64}#[a-f0-9]{64}$`),
      );
    } finally {
      spy.mockRestore();
    }
  },
);

it("rejects a pair with an unusable regression even if the preview has neutral weights", async () => {
  const spy = vi
    .spyOn(valuePit, "previewPairSwitchAllocation")
    .mockResolvedValue({
      ...pairPreview,
      zScore: null,
      beta: null,
      correlation: null,
      activeLeg: "neutral",
      targets: { sh510300: 0.5, sh510500: 0.5 },
      scores: {},
    });
  try {
    await expect(
      resolveRebalanceTargets(pairPreset, day, book),
    ).rejects.toThrow("现货配对");
  } finally {
    spy.mockRestore();
  }
});

it("fails closed when the local account data source has no completed pair bars", async () => {
  await expect(
    resolveRebalanceTargets(pairPreset, day, {
      ...book,
      config: { ...book.config, tdxRoot: "" },
    }),
  ).rejects.toThrow("现货配对缺少连续两腿已完成日线");
});

it("rejects a pair preview with a score but no targets", async () => {
  const spy = vi
    .spyOn(valuePit, "previewPairSwitchAllocation")
    .mockResolvedValue({
      ...pairPreview,
      targets: {},
      scores: {},
    });
  try {
    await expect(
      resolveRebalanceTargets(pairPreset, day, book),
    ).rejects.toThrow("现货配对");
  } finally {
    spy.mockRestore();
  }
});

it("rejects macro targets whose first available date follows the decision date", async () => {
  const spy = vi
    .spyOn(valuePit, "previewMacroClockAllocation")
    .mockReturnValue({
      ...macroPreview,
      availableAt: "2024-05-01",
    });
  try {
    await expect(
      resolveRebalanceTargets(macroPreset, day, book),
    ).rejects.toThrow("可用日");
  } finally {
    spy.mockRestore();
  }
});
