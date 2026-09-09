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
vi.mock("../src/server/chan-method", () => ({
  chanMethod: async () => ({
    version: "chan-annotation-1",
    source: "fixture",
    files: [],
    passages: [
      "02-morphology.md",
      "03-center-and-trend.md",
      "04-dynamics.md",
      "05-trading-points.md",
    ].map((file, i) => ({
      id: `p${i}`,
      file,
      line: 1,
      heading: "h",
      lessons: [62],
      quote: "引文",
    })),
  }),
}));
import { analyzeChan, chanWindow } from "~/server/chan-report";
import { chanStageIds } from "~/server/chan-report-schema";
const now = Date.parse("2026-09-08T12:00:00+08:00");
const source: Snapshot = {
  id: "s1",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 1,
  hash: "untrusted",
  bars: Array.from({ length: 8 }, (_, i) => ({
    date: `2026-09-0${i + 1}`,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 1100,
  })),
};
beforeEach(() => {
  state.cache.clear();
  state.call.mockReset();
  state.call.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse({
      title: "标注",
      summary: "待核验",
      stages: chanStageIds.map((id, i) => ({
        id,
        status: "missing",
        summary: "不足",
        citations: [chanWindow(source, now).id],
        passageIds: [`p${Math.min(i, 3)}`],
        missing: ["结构未验收"],
        annotations: [],
      })),
      risks: ["假设"],
      nextSteps: ["人工核对"],
    }),
    tokens: 5,
  }));
});
it("uses completed bars and hashes actual content without mutating snapshots", () => {
  const before = structuredClone(source);
  const window = chanWindow(source, now);
  expect(window.bars).toHaveLength(7);
  expect(window.asOf).toBe("2026-09-07");
  expect(source).toEqual(before);
  const changed = structuredClone(source);
  changed.bars[0]!.close = 10.5;
  expect(chanWindow(changed, now).id).not.toBe(window.id);
  const broken = structuredClone(source);
  broken.bars[1]!.date = broken.bars[0]!.date;
  expect(() => chanWindow(broken, now)).toThrow("无效");
  expect(() =>
    chanWindow({ ...source, bars: source.bars.slice(0, 2) }, now),
  ).toThrow("三根");
});
it("caches validated annotation-only reports and captures the selected provider", async () => {
  const first = await analyzeChan(
    source,
    "标注问题",
    undefined,
    undefined,
    now,
  );
  expect(first).toMatchObject({
    mode: "annotation-only",
    automaticSignals: false,
    model: "codex:default",
  });
  expect(
    await analyzeChan(source, "标注问题", undefined, undefined, now),
  ).toEqual(first);
  expect(state.call).toHaveBeenCalledTimes(1);
  expect(state.call.mock.calls[0]![2]).toBe("codex:default");
  state.cache.set(first.id, {
    ...first,
    result: { ...first.result, stages: [] },
  });
  await expect(
    analyzeChan(source, "标注问题", undefined, undefined, now),
  ).rejects.toThrow("缓存");
  expect(state.call).toHaveBeenCalledTimes(1);
});
it("never saves a late model response after cancellation", async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const original = state.call.getMockImplementation()!;
  state.call.mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return original(...args);
  });
  const pending = analyzeChan(
    source,
    "取消",
    controller.signal,
    undefined,
    now,
  );
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish();
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.cache.size).toBe(0);
});
