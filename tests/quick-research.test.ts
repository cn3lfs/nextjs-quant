vi.mock("../src/server/cls-news", () => ({
  sharedNewsEvidence: vi.fn(() => []),
}));
import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({
  windmill: vi.fn(),
  local: vi.fn(),
  paid: vi.fn(),
  version: "vp-test-1",
  sector: false,
  sectorSource: "news-sector/background",
}));
function sharedBackground() {
  const text =
    mocks.sectorSource === "tmt-crowding/background"
      ? JSON.stringify({
          label: "UNIQUE_SECTOR_BACKGROUND",
          method: {
            skillId: "tmt-crowding",
            version: "tmt-crowding-1",
            files: [
              { file: "SKILL.md", hash: "a".repeat(64) },
              { file: "scripts/tmt_crowding.py", hash: "b".repeat(64) },
            ],
          },
        })
      : "UNIQUE_SECTOR_BACKGROUND";
  return {
    id: "shared-sector",
    source: "fixture shared",
    asOf: "2026-09-08",
    text,
    envelope: {
      source: mocks.sectorSource,
      payloadHash: createHash("sha256").update(text).digest("hex"),
    },
  };
}
vi.mock("../src/server/gf-windmill", () => ({
  sharedWindmillContext: mocks.windmill,
}));
vi.mock("../src/server/local-llm", () => ({ localCompletion: mocks.local }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.paid } };
  },
}));
vi.mock("../src/server/market-data", () => ({
  gatherEvidence: async (s: { symbol: string }) => [
    {
      id: `E-${s.symbol}`,
      source: "fixture",
      asOf: "2026-01-01",
      text: s.symbol,
    },
    ...(mocks.sector && s.symbol !== "sh600002"
      ? [
          sharedBackground(),
          {
            id: `sector-link-${s.symbol}`,
            source: "fixture link",
            asOf: "2026-09-08",
            text: JSON.stringify({
              symbol: s.symbol,
              backgroundId: "shared-sector",
            }),
          },
        ]
      : []),
  ],
}));
vi.mock("../src/server/research-skills", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/server/research-skills")>();
  return {
    ...original,
    volumePriceMethod: async () => ({
      instructions: "fixture method",
      use: {
        skillId: "volume-price-analysis",
        ruleVersion: mocks.version,
        outputSchema: "quick-review-1",
        files: [{ file: "SKILL.md", hash: "fixture" }],
        prerequisites: ["60 bars"],
      },
    }),
  };
});
import { quickResearch, quickReviewSchema } from "../src/server/quick-research";
import { sharedNewsEvidence } from "../src/server/cls-news";
import { volumePriceFacts } from "../src/server/research-skills";
import { defaultStrategy, type Snapshot, type Report } from "../src/lib/domain";
import { sqlite, get, list, put } from "../src/server/db";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-quick-"));
const sources: Snapshot[] = Array.from({ length: 10 }, (_, i) => ({
  id: `snapshot-${i}`,
  hash: `hash-${i}`,
  symbol: `sh60000${i}`,
  name: `样本${i}`,
  source: "tdx-local",
  period: "day",
  adjustment: "none",
  createdAt: 1,
  bars: Array.from({ length: 60 }, (_, j) => ({
    date: new Date(Date.UTC(2025, 0, j + 1)).toISOString().slice(0, 10),
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: j === 59 ? 200 : 100,
    amount: 1000,
  })),
}));
const reply = (selected: Snapshot[]) => ({
  text: JSON.stringify({
    items: selected.map((s) => ({
      symbol: s.symbol,
      summary: "观察",
      position: "区间待确认",
      pattern: "量价观察",
      opposing: [],
      confirmation: "等待确认",
      invalidation: "跌破区间",
      risks: [],
      missing: [],
      citations: [`E-${s.symbol}`],
    })),
  }),
  tokens: 100,
});
beforeEach(() => {
  mocks.windmill.mockReset().mockResolvedValue({
    evidence: [],
    skills: [],
    missing: ["指数估值背景不可用"],
  });
  sqlite().prepare("DELETE FROM records").run();
  put("settings", "settings", { llmProvider: "codex" });
  mocks.local.mockReset();
  mocks.paid.mockReset();
  mocks.version = "vp-test-1";
  mocks.sector = false;
  mocks.sectorSource = "news-sector/background";
});
it("records batch preparation, model and save counts without executing pending batches after a failure", async () => {
  const progress = vi.fn();
  mocks.local.mockRejectedValueOnce(new Error("fixture quota exhausted"));
  const result = await quickResearch(
    sources,
    defaultStrategy,
    undefined,
    progress,
  );
  expect(result.paused).toBe(true);
  expect(mocks.local).toHaveBeenCalledOnce();
  const counts = progress.mock.calls.map((call) => call[3]).filter(Boolean);
  expect(counts).toContainEqual({
    stage: "第 1 批：获取证据",
    unit: "候选",
    processed: 5,
    total: 5,
    failed: 0,
    excluded: 0,
  });
  expect(counts.at(-1)).toEqual({
    stage: "第 1 批：等待或执行模型快评",
    unit: "批次",
    processed: 1,
    total: 1,
    failed: 1,
    excluded: 0,
  });
  expect(counts.some((c) => c.stage.includes("第 2 批"))).toBe(false);
  expect(mocks.paid).not.toHaveBeenCalled();
});
it("counts a shared preparation failure as one failed step rather than model failures", async () => {
  const progress = vi.fn();
  mocks.windmill.mockRejectedValueOnce(new Error("fixture context error"));
  await expect(
    quickResearch(sources, defaultStrategy, undefined, progress),
  ).rejects.toThrow("context error");
  expect(progress.mock.calls.at(-1)?.[3]).toEqual({
    stage: "准备共享市场背景",
    unit: "步骤",
    processed: 1,
    total: 1,
    failed: 1,
    excluded: 0,
  });
  expect(mocks.local).not.toHaveBeenCalled();
});
it.each(["news-sector/background", "tmt-crowding/background"])(
  "%s 在批次提示只出现一次，不同业不能引用",
  async (kind) => {
    mocks.sector = true;
    mocks.sectorSource = kind;
    const selected = sources.slice(0, 3);
    mocks.local.mockResolvedValueOnce(reply(selected));
    const result = await quickResearch(selected, defaultStrategy);
    expect(result.reportIds).toHaveLength(3);
    const prompt = String(mocks.local.mock.calls[0]![1]);
    expect(prompt.match(/UNIQUE_SECTOR_BACKGROUND/g)).toHaveLength(1);
    const reports = result.reportIds.map((id) => get<Report>(id)!);
    expect(reports[0]!.evidence.some((e) => e.id === "shared-sector")).toBe(
      true,
    );
    expect(reports[1]!.evidence.some((e) => e.id === "shared-sector")).toBe(
      true,
    );
    expect(reports[2]!.evidence.some((e) => e.id === "shared-sector")).toBe(
      false,
    );
    expect(reports[2]!.skills?.some((s) => s.skillId === "tmt-crowding")).toBe(
      false,
    );
    if (kind === "tmt-crowding/background")
      expect(
        reports[0]!.skills?.some((s) => s.skillId === "tmt-crowding"),
      ).toBe(true);
    const data = JSON.parse(reply(selected).text);
    data.items[2].citations = ["shared-sector"];
    expect(
      quickReviewSchema(
        new Map(selected.map((s, i) => [s.symbol, reports[i]!.evidence])),
      ).safeParse(data).success,
    ).toBe(false);
  },
);
it("Top10 uses two Codex calls, persists provenance, and identical evidence hits cache", async () => {
  const progress = vi.fn();
  mocks.local
    .mockResolvedValueOnce(reply(sources.slice(0, 5)))
    .mockResolvedValueOnce(reply(sources.slice(5)));
  const first = await quickResearch(
    sources,
    defaultStrategy,
    undefined,
    progress,
  );
  expect(
    progress.mock.calls.map((call) => call[4]?.length).filter(Boolean),
  ).toContain(5);
  expect(
    progress.mock.calls.map((call) => call[4]?.length).filter(Boolean),
  ).toContain(10);
  expect(
    progress.mock.calls.find((call) => call[4]?.length === 5)?.[4],
  ).toEqual(first.reportIds.slice(0, 5));
  expect(first.reportIds).toHaveLength(10);
  expect(first.paused).toBe(false);
  expect(mocks.local).toHaveBeenCalledTimes(2);
  expect(mocks.local.mock.calls.every((call) => call[0] === "codex")).toBe(
    true,
  );
  const report = get<Report>(first.reportIds[0]!)!;
  expect(report.skills?.[0]?.ruleVersion).toBe("vp-test-1");
  expect(report.batchUsage).toMatchObject({ tokens: 100, reports: 5 });
  expect(report.missing).toContain("全市场情绪与行业背景尚不完整");
  const cachedProgress = vi.fn();
  expect(
    (await quickResearch(sources, defaultStrategy, undefined, cachedProgress))
      .reportIds,
  ).toEqual(first.reportIds);
  expect(cachedProgress.mock.calls.some((call) => call[4]?.length === 5)).toBe(
    true,
  );
  expect(mocks.local).toHaveBeenCalledTimes(2);
  expect(mocks.paid).not.toHaveBeenCalled();
  mocks.version = "vp-test-2";
  mocks.local
    .mockResolvedValueOnce(reply(sources.slice(0, 5)))
    .mockResolvedValueOnce(reply(sources.slice(5)));
  expect((await quickResearch(sources, defaultStrategy)).reportIds).not.toEqual(
    first.reportIds,
  );
  expect(mocks.local).toHaveBeenCalledTimes(4);
});

it("shares one market query across both batches and stores the same evidence and method per report", async () => {
  const evidence = {
    id: "windmill-shared",
    source: "fixture",
    asOf: "2025-03-01",
    text: "UNIQUE_WINDMILL_CONTEXT",
  };
  const use = {
    skillId: "gf-windmill",
    ruleVersion: "gf-windmill-1",
    outputSchema: "gf-windmill-1",
    files: [],
    prerequisites: [],
  };
  mocks.windmill.mockResolvedValue({
    evidence: [evidence],
    skills: [use],
    missing: ["部分指数背景，不代表全市场情绪"],
  });
  mocks.local
    .mockResolvedValueOnce(reply(sources.slice(0, 5)))
    .mockResolvedValueOnce(reply(sources.slice(5)));
  const result = await quickResearch(sources, defaultStrategy);
  expect(mocks.windmill).toHaveBeenCalledOnce();
  expect(mocks.local).toHaveBeenCalledTimes(2);
  for (const call of mocks.local.mock.calls)
    expect(String(call[1]).match(/UNIQUE_WINDMILL_CONTEXT/g)).toHaveLength(1);
  for (const id of result.reportIds) {
    const report = get<Report>(id)!;
    expect(report.evidence).toContainEqual(evidence);
    expect(report.skills).toContainEqual(use);
    expect(report.missing).not.toContain("行业与大盘背景缺失");
    expect(report.promptVersion).toBe("quick-review-2");
  }
});
it("historical quick review omits current news and rejects mixed cutoff batches", async () => {
  vi.mocked(sharedNewsEvidence).mockClear();
  const historical = [{ ...sources[0]!, historicalAsOf: "2025-03-01" }];
  mocks.local.mockResolvedValueOnce(reply(historical));
  const reviewed = await quickResearch(historical, defaultStrategy);
  expect(mocks.windmill).not.toHaveBeenCalled();
  expect(reviewed.reportIds).toHaveLength(1);
  expect(sharedNewsEvidence).not.toHaveBeenCalled();
  const report = get<Report>(reviewed.reportIds[0]!)!;
  expect(
    report.evidence.some((entry) => entry.id === "historical-context-missing"),
  ).toBe(true);
  await expect(
    quickResearch([...historical, sources[1]!], defaultStrategy),
  ).rejects.toThrow("同一截止日");
});
it("a later batch failure keeps completed reports and pauses without paid fallback", async () => {
  mocks.local
    .mockResolvedValueOnce(reply(sources.slice(0, 5)))
    .mockRejectedValueOnce(new Error("quota unavailable"));
  const result = await quickResearch(sources, defaultStrategy);
  expect(result.paused).toBe(true);
  expect(result.reportIds).toHaveLength(5);
  expect(result.failures[0]?.symbols).toEqual(
    sources.slice(5).map((s) => s.symbol),
  );
  expect(list("report")).toHaveLength(5);
  expect(mocks.paid).not.toHaveBeenCalled();
});
it("rejects cross-stock citations, duplicate items, and cancellation before invocation", async () => {
  const evidence = new Map(
    sources.slice(0, 2).map((s) => [
      s.symbol,
      [
        {
          id: `E-${s.symbol}`,
          source: "fixture",
          asOf: "2025-01-01",
          text: "",
        },
      ],
    ]),
  );
  const data = JSON.parse(reply(sources.slice(0, 2)).text);
  data.items[0].citations = data.items[1].citations;
  expect(quickReviewSchema(evidence).safeParse(data).success).toBe(false);
  data.items[0] = data.items[1];
  expect(quickReviewSchema(evidence).safeParse(data).success).toBe(false);
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    quickResearch(sources, defaultStrategy, cancel.signal),
  ).rejects.toThrow();
  expect(mocks.local).not.toHaveBeenCalled();
});
it("volume facts use an explicit including-current baseline and gate non-mainboard thresholds", () => {
  const facts = volumePriceFacts(sources[0]!);
  expect(facts.vma5IncludingCurrent).toBe(120);
  expect(facts.r).toBeCloseTo(200 / 120);
  expect(facts.volumeClass).toBe("明显放量");
  expect(
    volumePriceFacts({ ...sources[0]!, symbol: "sz300001" }).volumeClass,
  ).toBe("不适用/数据不足");
  expect(volumePriceFacts({ ...sources[0]!, period: "5m" }).priceClass).toBe(
    "不适用/数据不足",
  );
});
