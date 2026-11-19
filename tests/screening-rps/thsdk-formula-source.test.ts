import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
import { formulaScreenInputSchema } from "~/lib/screening/formula-screen-request";
import { scan } from "~/server/data-sources/tdx/tdx";
import {
  thsdkKlines,
  type ThsdkKlineResponse,
} from "~/server/data-sources/thsdk/thsdk-adapter";
import { get, sqlite } from "~/server/db";
import { readJob } from "~/server/db/jobs";
import { saveSettings, settings } from "~/server/infra/settings";
import {
  exportFormulaScreen,
  exportStoredFormulaScreen,
  formulaScreenJob,
} from "~/server/screening/formula-screen-service";
import type { StoredScreenResult } from "~/server/screening/screen-results";

vi.mock("~/server/data-sources/thsdk/thsdk-adapter", () => ({
  thsdkKlines: vi.fn(),
}));
vi.mock("~/server/data-sources/tdx/tdx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/data-sources/tdx/tdx")>()),
  scan: vi.fn(),
}));

const formula = {
  name: "THSDK 收盘价筛选",
  source: "选股:C>100;",
  parameters: {},
};
const marketSource = "thsdk";
const symbol = "sh600519";

it("defaults plain formulas to the local market source", () => {
  expect(formulaScreenInputSchema.parse(formula).marketSource).toBe("local");
});

it("accepts explicit THSDK pools of 1 and 200 symbols", () => {
  for (const size of [1, 200]) {
    const symbols = Array.from({ length: size }, (_, i) => `sh${600000 + i}`);
    expect(
      formulaScreenInputSchema.parse({ ...formula, marketSource, symbols }),
    ).toMatchObject({ marketSource, symbols });
  }
});

it.each([
  { label: "omitted", pool: {} },
  { label: "empty", pool: { symbols: [] } },
])("rejects an $label THSDK pool", ({ pool }) => {
  expect(() =>
    formulaScreenInputSchema.parse({ ...formula, marketSource, ...pool }),
  ).toThrow("请指定 1–200 只证券代码");
});

it("rejects a THSDK pool above 200 symbols", () => {
  const symbols = Array.from({ length: 201 }, (_, i) => `sh${600000 + i}`);
  const parsed = formulaScreenInputSchema.safeParse({
    ...formula,
    marketSource,
    symbols,
  });
  if (parsed.success) throw new Error("Accepted a pool of 201 symbols");
  expect(parsed.error.issues).toMatchObject([
    { code: "too_big", maximum: 200, path: ["symbols"] },
  ]);
});

describe("THSDK formula job", () => {
  const today = "2026-11-19";
  const lastCompleted = "2026-11-18";
  const now = Date.parse(`${today}T14:00:00+08:00`);
  // Candidate metrics require at least 21 completed sessions.
  const completedDates = Array.from(
    { length: 31 },
    (_, i) => new Date(Date.UTC(2026, 9, 19 + i)),
  )
    .filter((date) => date.getUTCDay() >= 1 && date.getUTCDay() <= 5)
    .map((date) => date.toISOString().slice(0, 10));
  const requestedSymbols = [symbol, "sz000001"];
  const provenance = {
    source: "thsdk-hq",
    adjustment: "forward",
    adjustmentSource: "thsdk-native",
    researchMode: "latest-thsdk",
    universeSource: "同花顺指定证券池（2 只）",
  };
  let directory: string;
  let database: ReturnType<typeof sqlite> | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "quant-thsdk-formula-"));
    vi.stubEnv("QUANT_DATA_DIR", directory);
    database = sqlite();
    saveSettings({ ...settings(), tdxRoot: join(directory, "missing-tdx") });
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(scan).mockReset().mockRejectedValue(new Error("Local TDX scan"));
    vi.mocked(thsdkKlines).mockReset();
  });

  afterEach(async () => {
    database?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("scans only the specified symbols, freezes completed bars and exports THSDK provenance", async () => {
    vi.mocked(thsdkKlines).mockImplementation(async (input) => {
      const { adjustment, end = today, limit = 2000, period } = input;
      if (adjustment !== "qfq" && adjustment !== "none")
        throw new Error(`Unexpected THSDK adjustment: ${adjustment}`);
      // The forming close would flip the formula match for both symbols.
      const bars = [...completedDates, today].map((date): Bar => {
        const qfqClose = date === today ? 80 : 120;
        const close = adjustment === "qfq" ? qfqClose : qfqClose * 2;
        return {
          date,
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 10000,
          amount: 2400000,
        };
      });
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
        items: input.symbols.map((symbol) => ({
          symbol,
          status: "ok",
          bars,
          historyExhausted: true,
          volumeUnit: "股",
        })),
      } satisfies ThsdkKlineResponse;
    });

    const started = formulaScreenJob({
      ...formula,
      marketSource,
      symbols: [...requestedSymbols].reverse(),
    });
    const job = await vi.waitFor(
      () => {
        const job = readJob(started.id);
        if (!job || job.status === "queued" || job.status === "running")
          throw new Error("THSDK formula job is still running");
        return job;
      },
      { timeout: 5000 },
    );

    expect(job.status, job.error).toBe("completed");
    expect(scan).not.toHaveBeenCalled();
    expect(
      vi.mocked(thsdkKlines).mock.calls.map(([input]) => ({
        symbols: input.symbols,
        adjustment: input.adjustment,
        period: input.period,
        end: input.end,
      })),
    ).toEqual(
      requestedSymbols.flatMap((symbol) =>
        ["qfq", "none"].map((adjustment) => ({
          symbols: [symbol],
          adjustment,
          period: "day",
          end: today,
        })),
      ),
    );
    const result = job.result as StoredScreenResult;
    expect(result).toMatchObject({
      ...provenance,
      total: 2,
      asOf: lastCompleted,
      errors: [],
    });
    expect(result.candidates.map((candidate) => candidate.symbol)).toEqual(
      requestedSymbols,
    );
    for (const candidate of result.candidates) {
      expect(candidate.metrics).toMatchObject({
        date: lastCompleted,
        close: 120,
      });
      const snapshot = get<Snapshot>(candidate.snapshotId);
      expect(snapshot).toMatchObject({
        source: "thsdk-hq",
        requestedSource: "thsdk",
        barStore: {
          adjustmentSource: "thsdk-native",
          formingDates: [],
          coverage: { to: lastCompleted, count: completedDates.length },
        },
      });
      expect(snapshot?.bars.map((bar) => bar.date)).toEqual(completedDates);
      expect(snapshot?.rawBars?.map((bar) => bar.date)).toEqual(completedDates);
      expect(snapshot?.rawBars?.at(-1)?.close).toBe(240);
    }

    const exported = exportFormulaScreen(job);
    expect(exported).toMatchObject({
      ...provenance,
      asOf: lastCompleted,
      total: 2,
      parameters: { symbols: requestedSymbols, period: "day" },
      candidates: result.candidates,
    });
    expect(exportStoredFormulaScreen(job.id)).toEqual(exported);
  });
});
