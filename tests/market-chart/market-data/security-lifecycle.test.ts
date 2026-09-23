import { expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../../src/server/data-sources/hithink/hithink-context", () => ({
  request: mocks.request,
}));
import {
  parseSecurityLifecycle,
  verifySecurityLifecycle,
  storedSecurityLifecycle,
} from "../../../src/server/market/security-lifecycle";
import { put } from "../../../src/server/db/index";
import { securityProfile } from "../../../src/server/market/securities";
import live from "../../fixtures/security-lifecycle-live.json";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-lifecycle-test-"),
);
const raw = {
  status_code: 0,
  code_count: 1,
  datas: [{ 股票代码: "600519.SH", 上市地点: "上海", 上市日期: "20010827" }],
  columns: [
    { key: "上市日期", type: "DATE", index_name: "新股上市日期" },
    { key: "退市日期", type: "DATE", index_name: "退市@退市日期" },
  ],
  token: "must-not-save",
};
it("keeps date provenance and explicitly missing delisting without a trading-status inference", () => {
  const result = parseSecurityLifecycle("sh600519", raw, 100);
  expect(result).toMatchObject({
    listingDate: "2001-08-27",
    delistingDate: null,
    fetchedAt: 100,
  });
  expect(result.warnings).toContain("退市日期缺失或字段类型未核验");
  expect(JSON.stringify(result)).not.toContain("must-not-save");
  expect(result).not.toHaveProperty("tradingStatus");
});
it("rejects another exchange, ambiguous rows and incomplete identity response", () => {
  expect(() => parseSecurityLifecycle("sz600519", raw, 100)).toThrow();
  expect(() =>
    parseSecurityLifecycle(
      "sh600519",
      { ...raw, datas: [{ ...raw.datas[0], 上市地点: "深圳" }] },
      100,
    ),
  ).toThrow("交易所");
  expect(() =>
    parseSecurityLifecycle(
      "sh600519",
      { ...raw, datas: [...raw.datas, ...raw.datas] },
      100,
    ),
  ).toThrow();
  expect(() =>
    parseSecurityLifecycle("sh600519", { ...raw, code_count: 2 }, 100),
  ).toThrow();
});
it("does not accept normalized impossible dates or ambiguous date metadata", () => {
  for (const value of ["20250230", "20251301", "2025011", 20250101]) {
    expect(
      parseSecurityLifecycle(
        "sh600519",
        { ...raw, datas: [{ ...raw.datas[0], 上市日期: value }] },
        100,
      ).listingDate,
    ).toBeNull();
  }
  for (const columns of [
    [],
    [{ key: "上市日期", type: "STRING" }],
    [...raw.columns, raw.columns[0]],
  ]) {
    expect(
      parseSecurityLifecycle("sh600519", { ...raw, columns }, 100).listingDate,
    ).toBeNull();
  }
});
it("keeps valid delisting evidence but rejects dates before listing", () => {
  const parse = (退市日期: string) =>
    parseSecurityLifecycle(
      "sh600519",
      { ...raw, datas: [{ ...raw.datas[0], 退市日期 }] },
      100,
    );
  expect(parse("20200101").delistingDate).toBe("2020-01-01");
  expect(parse("20000101").delistingDate).toBeNull();
  expect(parse("20000101").warnings).toContain(
    "退市日期早于上市日期，未采纳退市日期",
  );
});
it("coalesces requests, caches evidence and returns it with local master without a second request", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "test");
  mocks.request.mockResolvedValue(raw);
  const [first, second] = await Promise.all([
    verifySecurityLifecycle("sh600519"),
    verifySecurityLifecycle("sh600519"),
  ]);
  expect(second).toEqual(first);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(await verifySecurityLifecycle("sh600519")).toEqual(first);
  const root = mkdtempSync(join(tmpdir(), "quant-lifecycle-root-"));
  put("settings", "settings", { tdxRoot: root });
  put("security-directory", "security-directory", {
    root,
    hash: "old",
    entries: {
      sh600519: {
        symbol: "sh600519",
        name: "原名称",
        aliases: [],
        market: "sh",
        type: "A股",
        currency: "CNY",
        nameSource: "tdx-tnf",
        tradingStatus: "unknown",
        updatedAt: 1,
      },
    },
  });
  expect(await securityProfile("sh600519")).toMatchObject({
    profile: { name: "原名称", tradingStatus: "unknown" },
    lifecycle: first,
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs();
});
it("failed refresh preserves previous evidence", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "test");
  const old = parseSecurityLifecycle("sh600519", raw, 1);
  put("security-lifecycle", "security-lifecycle-sh600519", old);
  mocks.request.mockRejectedValue(new Error("unavailable"));
  await expect(verifySecurityLifecycle("sh600519")).rejects.toThrow(
    "unavailable",
  );
  expect(storedSecurityLifecycle("sh600519")).toEqual(old);
  vi.unstubAllEnvs();
});

it("replays Shanghai, Shenzhen and Beijing live dates while reporting empty retired lookup explicitly", () => {
  for (const [index, symbol, expected] of [
    [0, "sh600519", "2001-08-27"],
    [1, "sz000001", "1991-04-03"],
    [2, "bj920748", "2023-08-16"],
  ] as const) {
    const fixture = live[index]!;
    expect(
      parseSecurityLifecycle(symbol, fixture.raw, fixture.fetchedAt)
        .listingDate,
    ).toBe(expected);
  }
  const empty = live[3]!;
  expect(() =>
    parseSecurityLifecycle("sh600005", empty.raw, empty.fetchedAt),
  ).toThrow("未返回该证券的上市资料");
});

it("rejects a same-key DATE column with another source meaning and retains semantic provenance", () => {
  const changed = structuredClone(live[0]!);
  changed.raw.columns.find((column) => column.key === "上市日期")!.index_name =
    "公司成立日期";
  expect(
    parseSecurityLifecycle("sh600519", changed.raw, changed.fetchedAt)
      .listingDate,
  ).toBeNull();
  const result = parseSecurityLifecycle(
    "sh600519",
    live[0]!.raw,
    live[0]!.fetchedAt,
  );
  expect(
    result.evidence.columns.find((column) => column.key === "上市日期")
      ?.index_name,
  ).toBe("新股上市日期");
});

it("makes cached date evidence available even when local name master has no entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "quant-lifecycle-empty-"));
  put("settings", "settings", { tdxRoot: root });
  const dates = parseSecurityLifecycle(
    "sz000001",
    live[1]!.raw,
    live[1]!.fetchedAt,
  );
  put("security-lifecycle", "security-lifecycle-sz000001", dates);
  expect(await securityProfile("sz000001")).toEqual({
    root,
    profile: null,
    lifecycle: dates,
    tradingStatus: null,
  });
});

it("refreshes v1 cache before claiming semantic verification", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "test");
  mocks.request.mockReset();
  const old = {
    ...parseSecurityLifecycle("sh600519", raw, Date.now()),
    version: "security-lifecycle-1",
  };
  put("security-lifecycle", "security-lifecycle-sh600519", old);
  mocks.request.mockResolvedValue(raw);
  expect((await verifySecurityLifecycle("sh600519")).version).toBe(
    "security-lifecycle-2",
  );
  expect(mocks.request).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs();
});
