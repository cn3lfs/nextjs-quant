import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import type {
  FrozenChanObservation,
  NativeStudyIdentity,
} from "trading-strategies";
import { settingsSchema } from "~/lib/domain";
import { readBars, type BarSeries } from "~/server/market/bar-store/read-bars";
import {
  missingCausalPriceBasis,
  readResearchPriceActions,
} from "~/server/research/causal-price-basis";
import {
  prepareLabBacktest,
  replayLabBacktest,
  type LabBacktestWork,
} from "~/server/research/lab-backtest";
import { runDiagnostics } from "../../../scripts/lib/backtest-diagnose/diagnostics";
import {
  prepareDiagnoseRequest,
  type PrepareDiagnoseRequestInput,
} from "../../../scripts/lib/backtest-diagnose/prepare-request";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: vi.fn() }));
vi.mock("~/server/research/causal-price-basis", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/research/causal-price-basis")
  >()),
  readResearchPriceActions: vi.fn(async () => ({
    events: new Map(),
    issues: [],
    recordCount: 0,
    sourceSha256: "synthetic GBBQ",
  })),
}));
vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "synthetic execution build",
}));
vi.mock("~/server/strategies/strategy-center-native", () => ({
  captureNativeChanObservations: () => {
    throw new Error("Expected injected native capture in diagnostic test");
  },
}));

const symbol = "sh600000";
const firstIndex = 140;
const sessionDates: string[] = [];
for (let day = 0; sessionDates.length < 152; day++) {
  const date = new Date(Date.UTC(2024, 0, day + 1));
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
    sessionDates.push(date.toISOString().slice(0, 10));
}
const offCalendarDate = sessionDates[141]!;
const benchmarkDates = sessionDates.filter((date) => date !== offCalendarDate);
const start = benchmarkDates[firstIndex]!;
const end = benchmarkDates.at(-1)!;
const buyDate = benchmarkDates[141]!;
const timeExitDate = benchmarkDates[145]!;
const sellDate = benchmarkDates[146]!;
const config = settingsSchema.parse({ tdxRoot: "D:/synthetic-only" });
const input = {
  strategy: buildStrategy("research-chan", [symbol], "single"),
  start,
  end,
  initial: 10_000,
  riskPerTrade: 0.02,
  maxPositions: 1,
  costScenario: "fixed",
} satisfies LabBacktestWork["input"];
const work: LabBacktestWork = {
  type: "lab-backtest",
  input: { ...input, source: "local" },
};
const identity = {
  dllHash: "a".repeat(64),
  apiVersion: 22,
  buildCommit: "fixture-native-build",
  configId: "fixture-config",
  config: 0,
  anchor: 1,
} satisfies NativeStudyIdentity;

function stubBars(includeOffCalendar: boolean) {
  vi.mocked(readBars).mockImplementation(async ({ instrument, period }) => {
    const ticker = instrument.symbol;
    const dates =
      ticker === "sh000001"
        ? benchmarkDates
        : ticker === symbol
          ? includeOffCalendar
            ? sessionDates
            : benchmarkDates
          : null;
    if (!dates) throw new Error(`Unexpected fixture symbol ${ticker}`);
    const bars: Bar[] = dates.map((date) => ({
      date,
      open: date === buyDate ? 10.3 : date === sellDate ? 9.8 : 10,
      high: 10.5,
      low: 9.5,
      close: 10,
      volume: 1_000_000,
      amount: 10_000_000,
    }));
    return {
      id: `fixture-${ticker}`,
      hash: `synthetic-${ticker}`,
      symbol: ticker,
      market: "cn-equity",
      period,
      source: "tdx-local",
      requestedSource: "local",
      adjustment: "none",
      createdAt: 0,
      bars,
      rawBars: bars,
      barStore: {
        version: "bar-store-1",
        market: "cn-equity",
        sourceFingerprint: "fixture",
        sourceVersions: ["fixture"],
        adjustment: "none",
        adjustmentReference: "raw",
        coverage: {
          from: dates[0]!,
          to: end,
          count: dates.length,
          historyExhausted: true,
        },
        formingDates: [],
        overlay: null,
        excluded: [],
      },
    } satisfies BarSeries;
  });
}

function captureFixture() {
  return vi.fn<NonNullable<PrepareDiagnoseRequestInput["captureNative"]>>(
    async (bars, first) => {
      const endpointDate = bars[first - 3]!.date;
      const confirmedDate = bars[first]!.date;
      const baselineDate = bars[first - 1]!.date;
      const signal = {
        key: `${endpointDate}:3`,
        endpointIndex: first - 3,
        endpointDate,
        confirmedAt: first,
        confirmedDate,
        centerId: 1,
        center: {
          start: 90,
          end: 100,
          startDate: bars[90]!.date,
          endDate: bars[100]!.date,
          ZD: 7,
          ZG: 8,
          confirmedAt: 104,
          established: 103,
        },
      };
      const observations: FrozenChanObservation[] = bars
        .slice(first - 1)
        .map((bar, offset) => ({
          date: bar.date,
          prefixHash: createHash("sha256")
            .update(JSON.stringify(bars.slice(0, first + offset)))
            .digest("hex"),
          identity,
          baseline: offset === 0,
          signals: offset === 1 ? [signal] : [],
          gaps: [],
        }));
      return {
        version: "strategy-center-native-1",
        identity,
        originDate: bars[0]!.date,
        baselineDate,
        priceBasis: "forward-cash-dividend-adjusted",
        observations,
        audit: [
          {
            date: confirmedDate,
            key: signal.key,
            event: "first-seen",
            after: signal,
          },
        ],
        pending: [
          { date: baselineDate, details: ["endpoint pending confirmation"] },
        ],
        boundary: "synthetic native capture",
      };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("rejects the native strategy in production before loading market evidence", async () => {
  await expect(
    prepareLabBacktest(work, undefined, undefined, undefined, { config }),
  ).rejects.toThrow("该策略需要原生/时点外部证据");
  expect(readResearchPriceActions).not.toHaveBeenCalled();
  expect(readBars).not.toHaveBeenCalled();
});

it.each([
  { label: "missing", external: undefined },
  { label: "empty", external: { chan: [] } },
])("rejects replay with $label external.chan", async ({ external }) => {
  stubBars(false);
  const frozen = await prepareLabBacktest(
    work,
    undefined,
    undefined,
    undefined,
    {
      config,
      allowNativeChan: true,
      forceCausalPrice: true,
    },
  );
  frozen.request.instruments[0]!.external = external;
  expect(() => replayLabBacktest(frozen)).toThrow(
    `${symbol}：原生缠论策略缺少逐前缀观察输入（external.chan）`,
  );
});

it.each([
  { label: "with an off-calendar stock bar", includeOffCalendar: true },
  { label: "with fully aligned bars", includeOffCalendar: false },
])(
  "captures and diagnoses native replay $label",
  async ({ includeOffCalendar }) => {
    stubBars(includeOffCalendar);
    const captureNative = captureFixture();
    const prepared = await prepareDiagnoseRequest({
      ...input,
      config,
      forceCausalPrice: true,
      captureNative,
    });
    const { frozen, calendar } = prepared;
    const instrument = frozen.request.instruments[0]!;
    expect(readResearchPriceActions).toHaveBeenCalledExactlyOnceWith(
      config.tdxRoot,
    );
    expect(calendar).toEqual(benchmarkDates.slice(firstIndex));
    expect(captureNative).toHaveBeenCalledTimes(1);
    const [signalBars, first] = captureNative.mock.calls[0]!;
    expect(signalBars).toBe(instrument.signalBars);
    expect(signalBars.map(({ date }) => date)).toEqual(benchmarkDates);
    expect(first).toBe(firstIndex);

    expect(prepared.nativeChan).toEqual([
      {
        symbol,
        identity,
        originDate: benchmarkDates[0],
        baselineDate: benchmarkDates[139],
        firstIndex,
        prefixCount: 12,
        captureElapsedMs: expect.any(Number),
        cacheLoadMs: null,
        auditCount: 1,
        pendingCount: 1,
        cached: false,
        signalPriceBasis: "gbbq-first-raw-anchor-1",
      },
    ]);
    expect(prepared.nativeChan![0]!.captureElapsedMs).toBeGreaterThanOrEqual(0);
    expect(frozen.sources).toEqual([
      expect.objectContaining({ symbol, nativeChan: prepared.nativeChan![0] }),
    ]);

    const replay = replayLabBacktest(frozen);
    expect(replay.result.fills).toMatchObject([
      {
        side: "buy",
        signalAt: start,
        date: buyDate,
      },
      {
        side: "sell",
        signalAt: timeExitDate,
        date: sellDate,
      },
    ]);
    const [buy, sell] = replay.result.fills;
    // The entry session is the first held day. The exit fires at the fifth
    // close and fills the following session, with 5 bp applied at each open.
    expect(buy!.price).toBeCloseTo(10.30515, 8);
    expect(sell!.price).toBeCloseTo(9.7951, 8);
    expect(sell!.quantity).toBe(buy!.quantity);
    expect(sell!.holdingAfter).toBe(0);

    const report = runDiagnostics({ request: frozen.request, frozen, replay });
    expect(report.status).toBe("ok");
    expect(report.checks.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "fillAfterSignal",
        "orderFillConservation",
        "feeMatches",
        "ledgerReconcile",
      ]),
    );
    expect(report.checks.filter(({ status }) => status !== "pass")).toEqual(
      includeOffCalendar
        ? [
            expect.objectContaining({
              id: "dataQuality",
              status: "warn",
              evidence: expect.objectContaining({
                offCalendar: [
                  expect.objectContaining({
                    symbol,
                    count: 1,
                    first: [offCalendarDate],
                  }),
                ],
              }),
            }),
          ]
        : [],
    );
  },
);

it("uses causal signal prices with forceCausalPrice disabled and rejects replay without their proof", async () => {
  stubBars(true);
  vi.mocked(readResearchPriceActions).mockResolvedValueOnce({
    events: new Map([
      [symbol, [{ date: start, category: 1, name: "dividend", dividend: 1 }]],
    ]),
    issues: [],
    recordCount: 1,
    sourceSha256: "synthetic GBBQ",
  });
  const { frozen } = await prepareDiagnoseRequest({
    ...input,
    config,
    captureNative: captureFixture(),
    forceCausalPrice: false,
  });
  const instrument = frozen.request.instruments[0]!;
  expect(instrument.bars[firstIndex]!.close).toBe(10);
  expect(instrument.signalBars[firstIndex]!.close).toBeCloseTo(
    (10 * 10) / 9,
    6,
  );
  expect(frozen.sources[0]!.causalPrice).toMatchObject({
    kind: "gbbq-first-raw-anchor-1",
    anchorDate: benchmarkDates[0],
  });
  expect(() => replayLabBacktest(frozen)).not.toThrow();
  delete frozen.sources[0]!.causalPrice;
  expect(() => replayLabBacktest(frozen)).toThrow(missingCausalPriceBasis);
});

it("prepares an exit-only Chan rule and requires its observations before the first eligible session", async () => {
  stubBars(false);
  const entry = { kind: "constant", value: false } as const;
  const strategy = {
    ...input.strategy,
    entry,
    exit: { rule: { kind: "chan-third-buy" as const, firstIndex } },
  };
  const { frozen } = await prepareDiagnoseRequest({
    ...input,
    strategy,
    start: benchmarkDates[firstIndex + 1]!,
    config,
    captureNative: captureFixture(),
    forceCausalPrice: false,
  });
  expect(frozen.request.strategies[0]).toMatchObject({
    entry,
    exit: { rule: { kind: "chan-third-buy", firstIndex: firstIndex + 1 } },
  });
  const instrument = frozen.request.instruments[0]!;
  expect(instrument.external?.chan?.[0]?.date).toBe(benchmarkDates[firstIndex]);
  frozen.request.calendar = benchmarkDates.slice(0, firstIndex);
  frozen.request.start = frozen.request.calendar[0]!;
  frozen.request.end = frozen.request.calendar.at(-1)!;
  expect(() => replayLabBacktest(frozen)).not.toThrow();
  delete instrument.external;
  expect(() => replayLabBacktest(frozen)).toThrow("external.chan");
});

it.each([
  "DLL hash",
  "truncated observations",
  "bars digest",
  "baseline prefix",
  "copied observations",
] as const)(
  "reuses a valid cache read-only and recaptures after %s corruption",
  async (corruption) => {
    stubBars(true);
    const nativeCacheDir = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "chan-cache-"),
    );
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const capture = captureFixture();
      const captureNative = vi.fn<
        NonNullable<PrepareDiagnoseRequestInput["captureNative"]>
      >(async (...args) => {
        now += 97;
        return capture(...args);
      });
      const prepare = () =>
        prepareDiagnoseRequest({
          ...input,
          config,
          forceCausalPrice: true,
          nativeCacheDir,
          captureNative,
        });
      const first = await prepare();
      expect(first.nativeChan?.[0]).toMatchObject({
        cached: false,
        captureElapsedMs: 97,
        cacheLoadMs: null,
      });
      expect(captureNative).toHaveBeenCalledTimes(1);
      const entries = await readdir(nativeCacheDir);
      expect(entries).toEqual([
        expect.stringMatching(/^chan-sh600000-[a-f0-9]{16}\.json$/),
      ]);
      const cachePath = join(nativeCacheDir, entries[0]!);
      const original = await readFile(cachePath, "utf8");
      const oldTime = new Date("2020-01-01T00:00:00Z");
      await utimes(cachePath, oldTime, oldTime);
      const { mtimeMs } = await stat(cachePath);

      const cached = await prepare();
      expect(cached.nativeChan?.[0]).toEqual({
        ...first.nativeChan![0],
        cached: true,
        cacheLoadMs: expect.any(Number),
      });
      expect(cached.nativeChan![0]!.cacheLoadMs).toBeGreaterThanOrEqual(0);
      expect(cached.frozen.request.instruments[0]!.external?.chan).toEqual(
        first.frozen.request.instruments[0]!.external?.chan,
      );
      expect(captureNative).toHaveBeenCalledTimes(1);
      expect(await readFile(cachePath, "utf8")).toBe(original);
      expect((await stat(cachePath)).mtimeMs).toBe(mtimeMs);

      const invalid = JSON.parse(original) as {
        identity: NativeStudyIdentity;
        barsDigest: string;
        observations: FrozenChanObservation[];
      };
      const bars = first.frozen.request.instruments[0]!.signalBars;
      expect(invalid.barsDigest).toBe(
        createHash("sha256").update(JSON.stringify(bars)).digest("hex"),
      );
      switch (corruption) {
        case "DLL hash":
          invalid.identity.dllHash = "b".repeat(64);
          break;
        case "truncated observations":
          invalid.observations.pop();
          break;
        case "bars digest":
          invalid.barsDigest = "0".repeat(64);
          break;
        case "baseline prefix":
        case "copied observations": {
          // Changing just the last close keeps the baseline valid. Replacing
          // only the baseline from another capture keeps the final hash valid.
          const changedIndex =
            corruption === "baseline prefix" ? 0 : bars.length - 1;
          const otherBars = bars.map((bar, index) =>
            index === changedIndex ? { ...bar, close: 10.25 } : bar,
          );
          const other = await captureFixture()(otherBars, firstIndex);
          if (corruption === "baseline prefix")
            invalid.observations[0] = other.observations[0]!;
          else invalid.observations = other.observations;
          break;
        }
      }
      await writeFile(cachePath, JSON.stringify(invalid));

      const repaired = await prepare();
      expect(captureNative).toHaveBeenCalledTimes(2);
      expect(repaired.nativeChan?.[0]).toEqual({
        ...first.nativeChan![0],
        captureElapsedMs: expect.any(Number),
      });
      expect(repaired.frozen.request.instruments[0]!.external?.chan).toEqual(
        first.frozen.request.instruments[0]!.external?.chan,
      );
      expect(await readFile(cachePath, "utf8")).toBe(original);
      expect(await readdir(nativeCacheDir)).toEqual(entries);
    } finally {
      clock.mockRestore();
      await rm(nativeCacheDir, { recursive: true, force: true });
    }
  },
);

it.each([
  { kind: "entry link", when: "before reading" },
  { kind: "directory entry", when: "before reading" },
  { kind: "entry link", when: "during capture" },
  { kind: "redirected root", when: "during capture" },
] as const)("rejects a $kind installed $when", async ({ kind, when }) => {
  stubBars(false);
  const parent = await mkdtemp(join(process.env.QUANT_DATA_DIR!, "chan-link-"));
  const nativeCacheDir = join(parent, "cache");
  const target = join(parent, "outside");
  try {
    await mkdir(target);
    const captureNative = captureFixture();
    const options = {
      ...input,
      config,
      forceCausalPrice: false,
      nativeCacheDir,
      captureNative,
    };
    await prepareDiagnoseRequest(options);
    const [name] = await readdir(nativeCacheDir);
    const file = join(nativeCacheDir, name!);
    const replacePath = async () => {
      if (kind === "redirected root") {
        await rename(nativeCacheDir, join(parent, "original"));
        await symlink(target, nativeCacheDir, "junction");
        return;
      }
      await rm(file);
      if (kind === "directory entry") await mkdir(file);
      else await symlink(target, file, "junction");
    };
    if (when === "before reading") await replacePath();
    else {
      await writeFile(file, "{}");
      captureNative.mockImplementationOnce(async (...args) => {
        await replacePath();
        return captureFixture()(...args);
      });
    }
    await expect(prepareDiagnoseRequest(options)).rejects.toThrow(
      kind === "redirected root"
        ? "escapes its directory"
        : "regular, non-symlink file",
    );
    expect(captureNative).toHaveBeenCalledTimes(
      when === "before reading" ? 1 : 2,
    );
    expect(await readdir(target)).toEqual([]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
