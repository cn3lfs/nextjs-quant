import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TdxXdxr } from "tstdx/wire";
import type { Bar } from "trading-strategy-core/bars";
import { settingsSchema } from "~/lib/domain";
import type {
  BarSeries,
  ReadBarsInput,
  readBars,
} from "~/server/market/bar-store/read-bars";
import { researchCorporateActions } from "~/server/research/corporate-actions";
import { forwardExecutionBuildHash } from "~/server/research/forward-identity";
import {
  prepareLabBacktest,
  replayLabBacktest,
  type LabBacktestWork,
} from "~/server/research/lab-backtest";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const { symbol, dividend, issues } = vi.hoisted(() => ({
  issues: [] as { offset: number; reason: string; symbol?: string }[],
  symbol: "sh600000",
  dividend: {
    date: "2025-01-08",
    category: 1,
    name: "cash dividend",
    dividend: 1,
  } satisfies TdxXdxr,
}));

vi.mock("~/server/research/causal-price-basis", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/research/causal-price-basis")
  >()),
  readResearchPriceActions: async () => ({
    events: new Map([[symbol, [dividend]]]),
    issues,
    sourceSha256: "synthetic GBBQ",
  }),
}));

vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: vi.fn(() => "fixture execution provenance"),
}));

const start = "2025-01-06";
const end = "2025-01-09";
const dates = [start, "2025-01-07", dividend.date, end];
const work = {
  type: "lab-backtest",
  input: {
    source: "local",
    strategy: buildStrategy("hold", [symbol], "single"),
    start,
    end,
    initial: 10_100,
    costScenario: "fixed",
  },
} satisfies LabBacktestWork;
const config = settingsSchema.parse({ tdxRoot: "D:/synthetic-only" });
const options = {
  config,
  forceCausalPrice: true,
  dataQualityMode: "record-only",
} as const;
const rawBars: Bar[] = dates.map((date, index) => {
  const close = index < 2 ? 50 : 49;
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100_000,
    amount: close * 100_000,
  };
});

function fixture(bars = rawBars) {
  const snapshot = {
    id: "fixture",
    hash: "synthetic provenance",
    symbol,
    market: "cn-equity",
    period: "day",
    source: "tdx-local",
    requestedSource: "local",
    adjustment: "none",
    createdAt: 0,
    bars,
    rawBars,
    barStore: {
      version: "bar-store-1",
      market: "cn-equity",
      sourceFingerprint: "fixture",
      sourceVersions: ["fixture"],
      adjustment: "none",
      adjustmentReference: "raw",
      coverage: {
        from: start,
        to: end,
        count: bars.length,
        historyExhausted: true,
      },
      formingDates: [],
      overlay: null,
      excluded: [],
    },
  } satisfies BarSeries;
  const query = vi.fn<(input: ReadBarsInput) => void>();
  const read: typeof readBars = async (input) => {
    query(input);
    return {
      ...snapshot,
      symbol: input.instrument.symbol,
      period: input.period,
    };
  };
  return { query, read };
}

it("freezes aligned causal signals and raw execution prices through the injected lab loader", async () => {
  const { query, read } = fixture();
  const frozen = await prepareLabBacktest(
    work,
    undefined,
    read,
    undefined,
    options,
  );
  expect(query).toHaveBeenCalledExactlyOnceWith({
    instrument: { market: "cn-equity", symbol },
    period: "day",
    adjustment: "none",
    freezeRaw: true,
    root: config.tdxRoot,
    source: "local",
    to: end,
    live: false,
  });
  const instrument = frozen.request.instruments[0]!;
  expect(instrument.bars.map(({ date }) => date)).toEqual(dates);
  expect(instrument.signalBars.map(({ date }) => date)).toEqual(dates);
  expect(instrument.bars[2]?.close).toBe(49);
  expect(instrument.signalBars[2]?.close).toBeCloseTo(50, 10);
  expect(instrument.actions).toHaveLength(1);
  expect(instrument.actions?.[0]).toMatchObject({
    date: dividend.date,
    dividend: 1,
  });
  expect(frozen.sources[0]?.causalPrice).toMatchObject({
    kind: "gbbq-first-raw-anchor-1",
    anchorDate: start,
  });
  const result = replayLabBacktest(frozen).result;
  // The initial order fills at the raw open 50 × 1.0005. Dividend on day 3 adds ¥200.
  expect(result.fills[0]?.price).toBeCloseTo(50.025, 8);
  expect(result.corporateActions[0]?.cash).toBe(200);
});

it.each([
  { issue: "a missing signal bar", bars: rawBars.slice(0, -1) },
  {
    issue: "a shifted signal date at equal length",
    bars: rawBars.map((bar, index) =>
      index === 2 ? { ...bar, date: "2025-01-08T07:00:00Z" } : bar,
    ),
  },
])("rejects $issue before freezing lab inputs", async ({ bars }) => {
  await expect(
    prepareLabBacktest(work, undefined, fixture(bars).read, undefined, options),
  ).rejects.toThrow(/原价与信号周期未对齐/);
});

it("maps per-share GBBQ dividends, bonus and rights fields to one ex-date action", () => {
  const [action] = researchCorporateActions(
    [
      {
        ...dividend,
        dividend: 0.5,
        bonusRatio: 0.2,
        rightsRatio: 0.1,
        rightsPrice: 4,
      },
      { ...dividend, date: "2025-01-10" },
    ],
    "synthetic GBBQ",
    start,
    end,
  );
  expect(action).toMatchObject({
    date: dividend.date,
    availableAt: dividend.date,
    cashAvailableAt: dividend.date,
    sharesSellableAt: dividend.date,
    timingAssumption: "ex-date-research-scenario",
    dividend: 0.5,
    bonus: 0.2,
    shareFactor: 1,
    rightsRatio: 0.1,
    rightsPrice: 4,
  });
  expect(action?.evidence).toContain("synthetic GBBQ");
});

it("rejects ambiguous same-day GBBQ entitlements instead of applying both", () => {
  expect(() =>
    researchCorporateActions(
      [dividend, { ...dividend, name: "another entitlement", dividend: 0.2 }],
      "synthetic GBBQ",
      start,
      end,
    ),
  ).toThrow(`Ambiguous same-day GBBQ entitlements ${dividend.date}`);
});

it("can prepare diagnostic inputs when the runtime worker identity is absent", async () => {
  const original = await vi.importActual<
    typeof import("~/server/research/forward-identity")
  >("~/server/research/forward-identity");
  vi.stubEnv(
    "QUANT_WORKER_DIR",
    join(process.env.QUANT_DATA_DIR!, "missing-runtime"),
  );
  vi.mocked(forwardExecutionBuildHash).mockImplementationOnce(
    original.forwardExecutionBuildHash,
  );
  try {
    await expect(
      prepareLabBacktest(work, undefined, fixture().read, undefined, options),
    ).resolves.toMatchObject({ request: { start, end } });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("blocks strict causal prices only for own or unattributable GBBQ issues", async () => {
  const other = "sz000001";
  const prepare = (
    target: string,
    policy: "strict" | "record-only" = "strict",
  ) =>
    prepareLabBacktest(
      {
        ...work,
        input: {
          ...work.input,
          strategy: buildStrategy("hold", [target], "single"),
        },
      },
      undefined,
      fixture().read,
      undefined,
      { ...options, gbbqIssuePolicy: policy },
    );
  issues.push({ symbol: other, offset: 4, reason: "事件日期非法" });
  try {
    const clean = await prepare(symbol);
    expect(clean.sources[0]?.causalPrice).toBeDefined();
    expect(clean.sources[0]).not.toHaveProperty("gbbqIssueCount");
    await expect(prepare(other)).rejects.toThrow(
      /Missing or invalid GBBQ evidence/,
    );
    issues.push({ offset: 33, reason: "无法归属" });
    await expect(prepare(symbol)).rejects.toThrow(
      /Missing or invalid GBBQ evidence/,
    );
    for (const [target, ownCount] of [
      [symbol, 0],
      [other, 1],
    ] as const) {
      const frozen = await prepare(target, "record-only");
      expect(frozen.sources[0]).toMatchObject({
        gbbqIssueCount: ownCount,
        gbbqUnattributedIssueCount: 1,
      });
    }
  } finally {
    issues.length = 0;
  }
});
