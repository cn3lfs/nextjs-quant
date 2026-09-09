import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import raw from "./fixtures/gf-windmill-20260908.json";
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  list: vi.fn(),
  call: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    close = mocks.close;
    listTools = mocks.list;
    callTool = mocks.call;
  },
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: mocks.read,
}));
import {
  parseWindmillPages,
  windmillEvidence,
  fetchWindmillPages,
  sharedWindmillContext,
} from "~/server/gf-windmill";
import { sqlite, put, get } from "~/server/db";
const now = Date.parse("2026-09-09T11:00:00+08:00");
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-windmill-test-"),
);
const use = {
  skillId: "gf-windmill",
  ruleVersion: "gf-windmill-1",
  outputSchema: "gf-windmill-1",
  files: [{ file: "SKILL.md", hash: "a".repeat(64) }],
  prerequisites: [],
};
function syntheticPage(page: number, total = 11) {
  return {
    retcode: 0,
    data: {
      page,
      total,
      perPage: Math.min(10, total - page * 10),
      list: Array.from({ length: Math.min(10, total - page * 10) }, (_, i) => {
        const code = String(399000 + page * 10 + i);
        return {
          ...raw.data.list[0]!,
          indexCode: `SZ${code}`,
          indexCode2: code,
          indexName: `fixture ${code}`,
        };
      }),
    },
  };
}
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset().mockResolvedValue({
    tools: [
      {
        name: "valuation_windmill_get",
        inputSchema: {
          type: "object",
          properties: {
            page: { type: "number" },
            perPage: { type: "number" },
          },
        },
      },
    ],
  });
  mocks.call.mockReset().mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(raw) }],
  });
  mocks.read
    .mockReset()
    .mockImplementation(async (path: string) =>
      path.endsWith("config.toml")
        ? '[mcp_servers.gf-windmill]\nargs=["--url","https://mcp-api.gf.com.cn/server/mcp/windmill/mcp"]'
        : "fixture valuation method",
    );
});

it("replays actual six-row response including source nulls, mixed windows and capped final perPage", () => {
  const archive = parseWindmillPages([raw], now);
  const e = windmillEvidence(archive, "2026-09-08", use),
    p = JSON.parse(e.text);
  expect(p.rows).toHaveLength(6);
  expect(p.rows[1]).toMatchObject({ indexName: "港股通消费", dataYears: 6 });
  expect(p.rows[0].dataYears).toBe(9);
  expect(p.rows[4]).toMatchObject({
    indexName: "中证A500",
    pePercent: null,
    pbPercent: null,
    dataYears: 0,
  });
  expect(p.rows[4].missing).toHaveLength(3);
  expect(p.rows[0].performanceUnit).toBeNull();
  expect(e.envelope!.asOf).toBe("2026-09-08");
  expect(e.envelope!.publishedAt).toBeNull();
  expect(e.text).not.toContain("buttonText");
  expect(windmillEvidence(archive, "2026-09-08", use)).toEqual(e);
});

it("rejects missing pages, duplicates, changed totals and wrong page numbers", async () => {
  const p = structuredClone(raw);
  p.data.total = 11;
  expect(() => parseWindmillPages([p], now)).toThrow();
  p.data.total = 6;
  p.data.list[1] = structuredClone(p.data.list[0]!);
  expect(() => parseWindmillPages([p], now)).toThrow("重复指数");
  p.data.page = 1;
  expect(() => parseWindmillPages([p], now)).toThrow("计数");
  const request = vi
    .fn()
    .mockResolvedValueOnce(syntheticPage(0, 11))
    .mockResolvedValueOnce(syntheticPage(1, 12));
  await expect(fetchWindmillPages(request)).rejects.toThrow("分页变化");
});

it("reads a complete multi-page response with a capped final page and stops exactly at total", async () => {
  const request = vi.fn(async (page: number) => syntheticPage(page));
  const archive = await fetchWindmillPages(request);
  expect(archive.pages.flatMap((p) => p.data.list)).toHaveLength(11);
  expect(request.mock.calls.map((c) => c[0])).toEqual([0, 1]);
});

it("replaces malformed cache after success and refuses changed tool parameter schemas", async () => {
  put("market-context", "windmill-cache-1", {
    version: "gf-windmill-1",
    fetchedAt: now,
    pages: [],
    hash: "invalid",
  });
  expect((await sharedWindmillContext("2026-09-08")).evidence).toHaveLength(2);
  expect(mocks.call).toHaveBeenCalledOnce();
  sqlite().prepare("DELETE FROM records").run();
  mocks.call.mockClear();
  mocks.list.mockResolvedValue({
    tools: [
      {
        name: "valuation_windmill_get",
        inputSchema: {
          type: "object",
          properties: { page: { type: "string" }, perPage: { type: "number" } },
        },
      },
    ],
  });
  expect((await sharedWindmillContext("2026-09-08")).evidence).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});

it("rejects identity, date, percentage and missing-window contradictions", () => {
  for (const patch of [
    { indexCode2: "000000" },
    { tradedate: "2026-02-30" },
    { tradedate: "2026-09-10" },
    { pePercent: 101 },
    { pbPercent: -1 },
    { pePercent: Infinity },
    { dataYears: 0 },
  ]) {
    const p = structuredClone(raw);
    Object.assign(p.data.list[0]!, patch);
    expect(() => parseWindmillPages([p], now)).toThrow();
  }
});

it("filters future and overage rows before model exposure and detects changed archives", () => {
  const p = structuredClone(raw);
  p.data.list[0]!.tradedate = "2026-09-09";
  p.data.list[1]!.tradedate = "2026-08-31";
  const archive = parseWindmillPages([p], now),
    result = JSON.parse(windmillEvidence(archive, "2026-09-08", use).text);
  expect(result.rows).toHaveLength(4);
  expect(result.excluded).toBe(2);
  expect(
    result.rows.some((r: { indexName: string }) => r.indexName === "创业板指"),
  ).toBe(false);
  archive.pages[0]!.data.list[2]!.pePercent = 0;
  expect(() => windmillEvidence(archive, "2026-09-08", use)).toThrow(
    "归档校验",
  );
  expect(() =>
    windmillEvidence(parseWindmillPages([raw], now), "2026-09-07", use),
  ).toThrow("没有截止日前");
});

it("shares concurrent requests, preserves original fetch time on cache hits, and stores method hash", async () => {
  const [a, b] = await Promise.all([
    sharedWindmillContext("2026-09-08"),
    sharedWindmillContext("2026-09-08"),
  ]);
  expect(a.evidence).toHaveLength(2);
  expect(b).toEqual(a);
  expect(mocks.call).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(a.skills[0]!.files[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
  vi.spyOn(Date, "now").mockReturnValue(now + 60000);
  const cached = await sharedWindmillContext("2026-09-08");
  expect(cached).toEqual(a);
  expect(mocks.call).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(a.evidence[0]!.text);
  expect(get(payload.archiveId)).toBeTruthy();
});

it("failed/empty methods and old research windows do not initiate network or fabricate context", async () => {
  expect((await sharedWindmillContext("2022-11-30")).evidence).toEqual([]);
  mocks.read.mockResolvedValue(" ");
  expect((await sharedWindmillContext("2026-09-08")).evidence).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});

it("source failure remains a visible gap, is not cached, and cancellation propagates", async () => {
  mocks.call.mockResolvedValue({ isError: true, content: [] });
  const result = await sharedWindmillContext("2026-09-08");
  expect(result.evidence).toEqual([]);
  expect(result.missing[0]).toContain("不可用");
  expect(get("windmill-cache-1")).toBeUndefined();
  const controller = new AbortController();
  controller.abort(new Error("test cancelled"));
  await expect(
    sharedWindmillContext("2026-09-08", controller.signal),
  ).rejects.toThrow("cancelled");
});

it("honors cancellation between pages rather than starting another request", async () => {
  const cancel = new AbortController();
  const request = vi.fn(async () => {
    cancel.abort(new Error("stop"));
    return raw;
  });
  await expect(fetchWindmillPages(request, cancel.signal)).rejects.toThrow(
    "stop",
  );
  expect(request).toHaveBeenCalledOnce();
});
