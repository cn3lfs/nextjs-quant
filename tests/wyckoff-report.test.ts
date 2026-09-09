import { beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
const state = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  call: vi.fn(),
}));
vi.mock("../src/server/db", () => ({
  get: (id: string) => state.cache.get(id),
  put: (_kind: string, id: string, value: unknown) => {
    state.cache.set(id, value);
    return value;
  },
}));
vi.mock("../src/server/research", () => ({
  researchModel: () => "codex:default",
  structured: state.call,
}));
vi.mock("../src/server/wyckoff-method", () => ({
  wyckoffMethod: async () => ({
    version: "fixture",
    source: "fixture",
    documents: [],
    files: [],
    boundaries: [],
  }),
}));
import { wyckoffFrames } from "~/server/wyckoff-frames";
import {
  wyckoffReportSchema,
  wyckoffStages,
  wyckoffStageFiles,
} from "~/server/wyckoff-report-schema";
import { analyzeWyckoff } from "~/server/wyckoff-report";
import { wyckoffRelativeStrength } from "~/server/wyckoff-relative-strength";
const dates = Array.from(
  { length: 60 },
  (_, i) => new Date(Date.UTC(2026, 5, 1 + i)),
)
  .filter((d) => ![0, 6].includes(d.getUTCDay()))
  .map((d) => d.toISOString().slice(0, 10));
const source: Snapshot = {
  id: "fixture-day",
  hash: "unused",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 1,
  bars: dates.map((date) => ({
    date,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 1100,
  })),
};
const calendar = { days: dates, source: "fixture", hash: "h" };
const now = Date.parse("2026-08-01T16:00:00+08:00");
const frames = wyckoffFrames(source, null, calendar, now);
const valid = () => ({
  title: "研究",
  summary: "假设待核验",
  stages: wyckoffStages.map((id) => ({
    id,
    status: "missing",
    summary: "待核验",
    citations: [frames.hash],
    methodFiles: [wyckoffStageFiles[id][0]],
    missing: ["数据缺口"],
  })),
  events: [
    {
      timeframe: "daily",
      index: 0,
      date: dates[0],
      name: "other",
      status: "hypothesis",
      rationale: "量价待核验",
      invalidation: "补充量价证据",
    },
  ],
  risks: ["阶段不确定", "企业行动未知", "小时缺失"],
  nextSteps: ["补数据"],
});
beforeEach(() => {
  state.cache.clear();
  state.call.mockReset();
  state.call.mockResolvedValue({ data: valid(), tokens: 3 });
});
it("rejects unsupported conclusions and events without matching usable bar evidence", () => {
  const schema = wyckoffReportSchema(frames);
  expect(schema.safeParse(valid()).success).toBe(true);
  for (const event of [
    { timeframe: "hourly" },
    { index: 999 },
    { date: "2099-01-01" },
    { status: "confirmed" },
  ]) {
    const value = valid();
    expect(
      schema.safeParse({ ...value, events: [{ ...value.events[0], ...event }] })
        .success,
    ).toBe(false);
  }
  for (const patch of [
    { status: "hypothesis" },
    { methodFiles: ["wyckoff-pf-targets.md"] },
    { citations: ["invented"] },
  ]) {
    const value = valid();
    expect(
      schema.safeParse({
        ...value,
        stages: [{ ...value.stages[0], ...patch }, ...value.stages.slice(1)],
      }).success,
    ).toBe(false);
  }
  expect(schema.safeParse({ ...valid(), targetPrice: 100 }).success).toBe(
    false,
  );
});
it("uses Codex and caches only validated complete reports", async () => {
  const report = await analyzeWyckoff(
    source,
    null,
    calendar,
    "研究",
    undefined,
    undefined,
    now,
  );
  expect(report).toMatchObject({
    model: "codex:default",
    automaticSignals: false,
    mode: "research-hypotheses",
  });
  expect(
    await analyzeWyckoff(
      source,
      null,
      calendar,
      "研究",
      undefined,
      undefined,
      now,
    ),
  ).toEqual(report);
  expect(state.call).toHaveBeenCalledTimes(1);
  state.cache.set(report.id, {
    ...report,
    result: { ...report.result, stages: [] },
  });
  await expect(
    analyzeWyckoff(source, null, calendar, "研究", undefined, undefined, now),
  ).rejects.toThrow("缓存");
  expect(state.call).toHaveBeenCalledTimes(1);
});
it("does not archive malformed or late cancelled replies", async () => {
  state.call.mockResolvedValue({
    data: { ...valid(), targetPrice: 100 },
    tokens: 3,
  });
  await expect(
    analyzeWyckoff(source, null, calendar, "非法", undefined, undefined, now),
  ).rejects.toThrow();
  expect(state.cache.size).toBe(0);
  let finish!: (value: unknown) => void;
  state.call.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = analyzeWyckoff(
    source,
    null,
    calendar,
    "取消",
    controller.signal,
    undefined,
    now,
  );
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish({ data: valid(), tokens: 3 });
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.cache.size).toBe(0);
});
it("archives market ratios and reuses unchanged evidence across acquisition times", async () => {
  const benchmark = {
    ...source,
    id: "index",
    symbol: "sh000300",
    source: "fixture-index",
  };
  const market = {
    version: "wyckoff-market-1",
    benchmark,
    rawHash: "a".repeat(64),
    relativeStrength: wyckoffRelativeStrength(
      source,
      benchmark,
      frames.daily.bars[0]!.date,
      frames.asOf,
    ),
    industry: { status: "missing", reason: "缺行业" },
    warnings: ["fixture"],
  };
  const first = await analyzeWyckoff(
    source,
    null,
    calendar,
    "市场",
    undefined,
    undefined,
    now,
    market,
  );
  expect(first.market?.relativeStrength.status).toBe("computed");
  expect(first.market?.relativeStrength.rows).toEqual(
    market.relativeStrength.rows,
  );
  expect(state.call.mock.calls[0]![0]).toContain("市场RS计算证据");
  expect(
    await analyzeWyckoff(
      source,
      null,
      calendar,
      "市场",
      undefined,
      undefined,
      now,
      { ...market, benchmark: { ...benchmark, createdAt: now } },
    ),
  ).toEqual(first);
  expect(state.call).toHaveBeenCalledTimes(1);
});
