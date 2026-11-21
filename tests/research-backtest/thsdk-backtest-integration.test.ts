import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tripleScreenStrategy, utcOrbStrategy } from "trading-strategies";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  labBacktestReceipt,
  readLabBacktestForm,
} from "~/components/research/lab-backtest";
import type { Bar } from "~/lib/domain";
import { labBacktestSchema } from "~/lib/research/lab-backtest";
import { sqlite } from "~/server/db";
import { saveSettings, settings } from "~/server/infra/settings";
import { runWorker } from "~/server/jobs/jobs";
import type {
  BarSeries,
  ReadBarsInput,
  readBars,
} from "~/server/market/bar-store/read-bars";
import {
  executeLabBacktest,
  prepareLabBacktest,
  type LabBacktestWork,
} from "~/server/research/lab-backtest";

vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "d".repeat(64),
}));

const symbol = "sh600519";
const strategy = {
  id: "thsdk-lab-test",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: [symbol] },
  entry: { kind: "dual-ma", fast: 2, slow: 3, side: "entry" },
  exit: { maxBars: 2 },
  sizing: { kind: "weight", weight: 0.2 },
  sleeve: "swing",
} satisfies LabBacktestWork["input"]["strategy"];
const fields = {
  start: "2025-01-02",
  end: "2025-01-09",
  initial: 1000000,
  costScenario: "fixed",
} as const;
const dates = [
  fields.start,
  "2025-01-03",
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
  fields.end,
];
const input = { ...fields, strategy };
const thsdkWork = {
  type: "lab-backtest",
  input: { ...input, source: "thsdk" },
} satisfies LabBacktestWork;

function fixtures(formingDates: string[] = []) {
  const bar = (date: string, close: number): Bar => ({
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100000,
    amount: 20000000,
  });
  const bars = [104, 100, 98, 104, 104, 104].map((close, i) =>
    bar(dates[i]!, close),
  );
  const rawBars = dates.map((date) => bar(date, 200));
  const snapshot = {
    id: "snapshot-thsdk-backtest",
    hash: "thsdk-backtest-prices",
    symbol,
    market: "cn-equity",
    period: "day",
    source: "thsdk-hq",
    requestedSource: "thsdk",
    adjustment: "forward",
    createdAt: Date.parse("2025-01-09T15:05:00+08:00"),
    volumeUnit: "股",
    bars,
    rawBars,
    barStore: {
      version: "bar-store-1",
      market: "cn-equity",
      sourceFingerprint: "thsdk-backtest-prices",
      sourceVersions: ["thsdk-test"],
      adjustment: "forward",
      adjustmentSource: "thsdk-native",
      adjustmentReference: `thsdk-native:qfq:${fields.end}`,
      coverage: {
        from: fields.start,
        to: fields.end,
        count: bars.length,
        historyExhausted: true,
      },
      formingDates,
      overlay: null,
      excluded: [],
    },
  } satisfies BarSeries;
  const request = vi.fn<(input: ReadBarsInput) => void>();
  const read: typeof readBars = async (input) => {
    request(input);
    return { ...snapshot, period: input.period };
  };
  return { bars, rawBars, read, request };
}

describe("THSDK lab request and receipt", () => {
  it("defaults to local and accepts an explicit THSDK source for A shares", () => {
    expect(labBacktestSchema.parse(input).source).toBe("local");
    expect(labBacktestSchema.parse(thsdkWork.input).source).toBe("thsdk");
  });

  it("rejects THSDK for a crypto strategy that otherwise validates", () => {
    const crypto = {
      ...input,
      strategy: {
        ...strategy,
        market: "crypto",
        universe: { kind: "symbols", symbols: ["cxBTCUSDT"] },
      },
    };
    expect(labBacktestSchema.parse(crypto).source).toBe("local");
    expect(() =>
      labBacktestSchema.parse({ ...crypto, source: "thsdk" }),
    ).toThrow("同花顺数据源仅支持 A 股策略回测");
  });

  it("keeps the default receipt shape for a form submitted without a source", () => {
    const form = readLabBacktestForm(JSON.stringify(strategy), fields);
    if (!form.ok) throw new Error(form.message);

    expect(form.input.source).toBe("local");
    expect(labBacktestReceipt(form.input, "job-local")).not.toHaveProperty(
      "source",
    );
  });

  it("preserves explicit THSDK selection in the parsed form and receipt", () => {
    const form = readLabBacktestForm(JSON.stringify(strategy), {
      ...fields,
      source: "thsdk",
    });
    if (!form.ok) throw new Error(form.message);

    expect(form.input.source).toBe("thsdk");
    expect(labBacktestReceipt(form.input, "job-thsdk")).toMatchObject({
      jobId: "job-thsdk",
      source: "thsdk",
    });
  });
});

describe("THSDK lab execution", () => {
  let directory: string;
  let database: ReturnType<typeof sqlite> | undefined;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "quant-thsdk-backtest-"));
    vi.stubEnv("QUANT_DATA_DIR", directory);
    database = sqlite();
  });
  afterAll(async () => {
    database?.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["unconfigured", "missing"])(
    "uses qfq for signals and raw prices for fills when the TDX root is %s",
    async (rootKind) => {
      const root =
        rootKind === "unconfigured" ? "" : join(directory, "missing");
      saveSettings({ ...settings(), tdxRoot: root });
      const { bars, rawBars, read, request } = fixtures();

      const backtest = await executeLabBacktest(thsdkWork, () => {}, read);

      expect(request).toHaveBeenCalledExactlyOnceWith({
        instrument: { market: "cn-equity", symbol },
        period: "day",
        adjustment: "forward",
        freezeRaw: true,
        root,
        source: "thsdk",
        to: fields.end,
        live: false,
      });
      expect(backtest.frozen.dataSource).toBe("thsdk");
      expect(backtest.frozen.corporateActionCoverage).toBe("excluded");
      expect(backtest.frozen.sources).toEqual([
        {
          symbol,
          hash: "thsdk-backtest-prices",
          source: "thsdk-hq",
          adjustment: `thsdk-native:qfq:${fields.end}`,
          adjustmentSource: "thsdk-native",
          volumeUnit: "股",
          dataAsOf: fields.end,
        },
      ]);
      expect(backtest.frozen.request.instruments[0]).toMatchObject({
        bars: rawBars,
        signalBars: bars,
        actions: [],
      });
      // qfq MA(2) crosses above MA(3) on Jan 7. Raw closes are flat.
      // The next day's raw open plus 5 bps is 200 × 1.0005 = 200.10.
      const firstFill = backtest.result.fills[0];
      expect(firstFill).toMatchObject({
        symbol,
        side: "buy",
        signalAt: "2025-01-07",
        date: "2025-01-08",
      });
      expect(firstFill?.price).toBeCloseTo(200.1, 8);
    },
  );

  it("replays the prepared THSDK prices in the bundled worker with the same results and evidence", async () => {
    const { read } = fixtures();
    const frozen = await prepareLabBacktest(thsdkWork, undefined, read);
    const replay = await runWorker({ type: "lab-backtest-replay", frozen });
    expect(replay).toEqual(
      await executeLabBacktest(thsdkWork, undefined, read),
    );
  });

  it("rejects an index anywhere in the THSDK universe before fetching any bars", async () => {
    const { read, request } = fixtures();
    const mixed = {
      ...strategy,
      universe: { ...strategy.universe, symbols: [symbol, "sh000001"] },
    };
    await expect(
      prepareLabBacktest(
        { ...thsdkWork, input: { ...thsdkWork.input, strategy: mixed } },
        undefined,
        read,
      ),
    ).rejects.toThrow(
      "同花顺回测仅支持 A 股股票标的，不支持指数或非股票代码：sh000001",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects snapshots with forming bars before replay", async () => {
    const { read } = fixtures([fields.end]);

    await expect(executeLabBacktest(thsdkWork, () => {}, read)).rejects.toThrow(
      "包含未完成或修复行情",
    );
  });

  it.each([
    tripleScreenStrategy("week-day", "cn-equity", [symbol]),
    utcOrbStrategy(),
  ])("rejects $entry.kind with THSDK before reading bars", async (preset) => {
    expect(labBacktestSchema.parse({ ...input, strategy: preset }).source).toBe(
      "local",
    );
    const { read, request } = fixtures();

    await expect(
      executeLabBacktest(
        { ...thsdkWork, input: { ...thsdkWork.input, strategy: preset } },
        () => {},
        read,
      ),
    ).rejects.toThrow("多周期理论策略需要本地日历与归档证据，请使用本地数据源");
    expect(request).not.toHaveBeenCalled();
  });
});
