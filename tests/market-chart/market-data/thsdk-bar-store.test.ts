import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAdjustment, adjustmentFactors, readGbbq } from "tstdx/local";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
import { chartBars } from "~/server/charts/chart-bars";
import {
  thsdkKlines,
  type ThsdkKlineResponse,
} from "~/server/data-sources/thsdk/thsdk-adapter";
import { put, sqlite } from "~/server/db";
import { readBars } from "~/server/market/bar-store/read-bars";

vi.mock("~/server/data-sources/thsdk/thsdk-adapter", () => ({
  thsdkKlines: vi.fn(),
}));

const instrument = { market: "cn-equity", symbol: "sh600519" } as const;
const request = {
  instrument,
  period: "day",
  source: "thsdk",
  adjustment: "forward",
  freezeRaw: true,
} as const;
const now = Date.parse("2026-11-19T14:00:00+08:00");
const dates = ["2026-11-16", "2026-11-17"];

function makeBars(days: string[], close: number): Bar[] {
  return days.map((date) => ({
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10000,
    amount: 2000000,
  }));
}

function mockKlines(adjusted: Bar[], raw: Bar[]) {
  vi.mocked(thsdkKlines).mockImplementation(async (input) => {
    const { adjustment, period, limit = 2000, end = "2026-11-19" } = input;
    if (adjustment !== "qfq" && adjustment !== "none")
      throw new Error(`Unexpected THSDK adjustment: ${adjustment}`);
    return {
      version: "thsdk-test",
      source: "thsdk-hq",
      adjustment,
      period,
      limit,
      end,
      currency: "CNY",
      volumeUnit: "股",
      delayed: true,
      fetchedAt: now,
      warnings: [],
      items: [
        {
          symbol: instrument.symbol,
          status: "ok",
          bars: adjustment === "qfq" ? adjusted : raw,
          volumeUnit: "股",
          historyExhausted: true,
        },
      ],
    } satisfies ThsdkKlineResponse;
  });
}

let directory: string;
let database: ReturnType<typeof sqlite> | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "quant-thsdk-bars-"));
  vi.stubEnv("QUANT_DATA_DIR", directory);
  vi.mocked(thsdkKlines).mockReset();
});
afterEach(async () => {
  database?.close();
  database = undefined;
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each(["missing", "local-gbbq"])(
  "keeps native qfq at 100 and freezes raw closes at 200 with a %s TDX root",
  async (rootKind) => {
    const root = join(directory, rootKind);
    const adjusted = makeBars(dates, 100);
    const raw = makeBars(dates, 200);
    if (rootKind === "local-gbbq") {
      const cache = join(root, "T0002", "hq_cache");
      await mkdir(cache, { recursive: true });
      // One synthetic sh600519 record: 10 bonus shares per 10 on 2026-11-17.
      await writeFile(
        join(cache, "gbbq"),
        Buffer.from(
          "010000009a7f1ae8eafde71929737333aaf53fb3063a42865e2b75304100000000",
          "hex",
        ),
      );
      const { events } = await readGbbq(root);
      expect(events.get(instrument.symbol)).toMatchObject([
        { date: "2026-11-17", category: 1, bonusRatio: 1 },
      ]);
      // The first close would be 100 × (1 / 2) = 50 if GBBQ ran again.
      const factors = adjustmentFactors(
        adjusted,
        events.get(instrument.symbol),
      );
      expect(applyAdjustment(adjusted, factors, "forward")[0]?.close).toBe(50);
    }

    mockKlines(adjusted, raw);
    const series = await readBars({ ...request, root, now });

    expect(series.bars.map((bar) => bar.close)).toEqual([100, 100]);
    expect(series.rawBars?.map((bar) => bar.close)).toEqual([200, 200]);
    expect(series.source).toBe("thsdk-hq");
    expect(series.barStore.adjustmentSource).toBe("thsdk-native");
    expect(series.barStore.adjustmentReference).toMatch(/^thsdk-native:qfq:/);
    expect(
      vi.mocked(thsdkKlines).mock.calls.map(([input]) => input.adjustment),
    ).toEqual(["qfq", "none"]);
  },
);

it("rejects equal-length qfq and raw histories with different dates", async () => {
  mockKlines(makeBars(dates, 100), makeBars(["2026-11-16", "2026-11-18"], 200));

  await expect(
    readBars({ ...request, root: join(directory, "missing"), now }),
  ).rejects.toThrow("同花顺原价与复权序列日期未对齐");
});

it("marks today's THSDK daily bar as forming at 14:00 and complete at 15:05 Beijing time", async () => {
  const today = "2026-11-19";
  mockKlines(makeBars([today], 100), makeBars([today], 200));
  const input = { ...request, root: join(directory, "missing") };

  const intraday = await readBars({ ...input, now });
  const afterClose = await readBars({
    ...input,
    now: Date.parse("2026-11-19T15:05:00+08:00"),
  });

  expect(intraday.barStore.formingDates).toEqual([today]);
  expect(afterClose.barStore.formingDates).toEqual([]);
  expect(afterClose.bars).toEqual(intraday.bars);
  expect(afterClose.bars.map((bar) => bar.date)).toEqual([today]);
});

it("charts a persisted THSDK snapshot with native qfq when local GBBQ is absent", async () => {
  database = sqlite();
  const adjusted = makeBars(dates, 100);
  const raw = makeBars(dates, 200);
  mockKlines(adjusted, raw);
  const source = {
    id: "snapshot-thsdk-test",
    symbol: instrument.symbol,
    period: "day",
    source: "thsdk-hq",
    requestedSource: "thsdk",
    adjustment: "none",
    dataRoot: join(directory, "missing"),
    bars: raw,
    hash: "thsdk-test-original",
    createdAt: now,
  } satisfies Snapshot;
  put("snapshot", source.id, source);

  const chart = await chartBars({
    snapshotId: source.id,
    period: "day",
    adjustment: "forward",
  });

  expect(chart).toMatchObject({
    source: "thsdk-hq",
    requestedSource: "thsdk",
    adjustment: "forward",
    bars: adjusted,
    barStore: {
      adjustmentSource: "thsdk-native",
      adjustmentReference: "thsdk-native:qfq:2026-11-17",
    },
  });
  expect(thsdkKlines).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      symbols: [instrument.symbol],
      period: "day",
      adjustment: "qfq",
    }),
  );
});
