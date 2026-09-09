import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot, Strategy } from "../src/lib/domain";
vi.mock("../src/server/research", () => ({ snapshotEvidence: () => [] }));
vi.mock("../src/server/hithink-finance", () => ({
  queryFinance: vi.fn(async () => ({
    id: "finance-fixture",
    source: "同花顺问财",
    asOf: "unknown",
    text: "fixture",
    fetchedAt: Date.now(),
    envelope: { version: "evidence-1" },
  })),
}));
vi.mock("../src/server/mcp", () => ({
  mcpConfigured: async () => true,
  queryMcp: vi.fn(async () => ({ data: "fixture" })),
}));
import { gatherEvidence } from "../src/server/market-data";
import { queryMcp } from "../src/server/mcp";
import { queryFinance } from "../src/server/hithink-finance";
import { put, sqlite } from "../src/server/db";
import { contextEvidence } from "../src/server/hithink-context";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-evidence-"));
vi.stubEnv("IWENCAI_API_KEY", "");
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  vi.mocked(queryMcp).mockClear();
  vi.mocked(queryFinance).mockClear();
});
it("historical snapshots never fetch current remote evidence", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
  vi.mocked(queryMcp).mockClear();
  const evidence = await gatherEvidence(
    { symbol: "sh600519", historicalAsOf: "2022-11-30" } as Snapshot,
    {} as Strategy,
  );
  expect(queryMcp).not.toHaveBeenCalled();
  expect(queryFinance).not.toHaveBeenCalled();
  expect(evidence.some((e) => e.id.startsWith("industry-news"))).toBe(false);
  vi.stubEnv("IWENCAI_API_KEY", "");
});

it("真实证据收集链在MCP前加入已归档行业背景，不额外调用模型", async () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
  try {
    const entry = contextEvidence(
      "sh600519",
      "hithink-basicinfo-query",
      "fixture",
      {
        status_code: 0,
        columns: [],
        datas: [{ 股票代码: "600519.SH", 所属申万一级行业: "食品饮料" }],
      },
    );
    put("evidence", "hithink-industry-v2-sh600519", {
      entries: [entry],
      fetchedAt: now,
    });
    put("news-sector", "sector-fixture", {
      id: "sector-fixture",
      cutoff: now - 1000,
      createdAt: now - 500,
      input: { industry: "食品饮料", analysisId: "fixture" },
      method: { version: "news-sector-1", files: [] },
      model: "fixture",
      coverage: { selected: 1, available: 1, classified: 1, original: 1 },
      classificationMethod: { version: "fixture", files: [] },
      result: { summary: { text: "模型推测", citations: [1] } },
      sources: [
        {
          classification: { id: 1, industry: "食品饮料" },
          news: {
            id: 1,
            content: "原文",
            hash: "fixture",
            publishedAt: new Date(now - 2000).toISOString(),
            collectedAt: null,
          },
        },
      ],
    });
    const evidence = await gatherEvidence(
      { symbol: "sh600519" } as Snapshot,
      {} as Strategy,
    );
    const background = evidence.find(
      (e) => e.envelope?.source === "news-sector/background",
    )!;
    expect(JSON.parse(background.text).reportId).toBe("sector-fixture");
    expect(
      evidence.some(
        (e) => e.envelope?.source === "news-sector/industry-association",
      ),
    ).toBe(true);
  } finally {
    clock.mockRestore();
    vi.stubEnv("IWENCAI_API_KEY", "");
  }
});

it("does not reuse legacy timestamps and refreshes quotes sooner than announcements", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000000);
  const source = { symbol: "sh600519" } as Snapshot;
  try {
    put("evidence", "evidence-sh600519-tdx_quotes", {
      id: "legacy",
      fetchedAt: 1000000,
      asOf: "misleading",
      text: "old",
    });
    const first = await gatherEvidence(source, {} as Strategy);
    expect(queryMcp).toHaveBeenCalledTimes(2);
    const remote = (entries: typeof first) =>
      entries.filter((entry) => entry.source !== "行业新闻关联检查");
    expect(remote(first).every((entry) => entry.envelope?.asOf === null)).toBe(
      true,
    );
    expect(
      first.find((entry) => entry.source === "行业新闻关联检查")?.text,
    ).toContain("未唯一核验");
    clock.mockReturnValue(1001000);
    expect(await gatherEvidence(source, {} as Strategy)).toEqual(first);
    expect(queryMcp).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1031000);
    const refreshed = await gatherEvidence(source, {} as Strategy);
    expect(queryMcp).toHaveBeenCalledTimes(3);
    expect(vi.mocked(queryMcp).mock.calls.at(-1)?.[0]).toBe("tdx_quotes");
    expect(remote(refreshed)[0]?.envelope?.fetchedAt).toBe(1031000);
    expect(remote(refreshed)[1]?.envelope?.fetchedAt).toBe(1000000);
  } finally {
    clock.mockRestore();
  }
});
