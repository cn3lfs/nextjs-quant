import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdir, copyFile, writeFile, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  auditUniverse,
  universeAuditLabels,
  type UniverseAuditInput,
  type UniverseAuditEvidence,
} from "../src/lib/universe-audit";
import { UniverseAuditResults } from "../src/components/screening/universe-audit-results";
import { universeAuditPage } from "../src/server/research/universe-audit";
import { get, put, sqlite } from "../src/server/db";
import { settings, saveSettings } from "../src/server/infra/settings";
import { ResearchStore } from "../src/server/backtest/research-store";
import { RpsStore } from "../src/server/screening/rps-store";
import { industryDay } from "./industry-rps-fixture";
import { readMarketPool } from "../src/server/market/market-pool-files";
import { tdxBlockFiles } from "../src/server/data-sources/tdx/tdx-local-blocks";

const blocked = vi.hoisted(() => ({
  request: vi.fn(() => {
    throw new Error("禁止外呼");
  }),
  verify: vi.fn(() => {
    throw new Error("禁止刷新");
  }),
}));
vi.mock("../src/server/data-sources/hithink/hithink-context", () => ({
  request: blocked.request,
}));
vi.mock("../src/server/market/security-lifecycle", async (original) => ({
  ...(await original<
    typeof import("../src/server/market/security-lifecycle")
  >()),
  verifySecurityLifecycle: blocked.verify,
}));
afterEach(() => {
  expect(blocked.request).toHaveBeenCalledTimes(0);
  expect(blocked.verify).toHaveBeenCalledTimes(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const evidence = (
  i: number,
  patch: Partial<UniverseAuditEvidence> = {},
): UniverseAuditEvidence => ({
  symbol: `sz${String(i).padStart(6, "0")}`,
  listingDate: null,
  delistingDate: null,
  lifecycleSource: "缓存 fixture",
  localFirstDate: null,
  localSource: "本地覆盖 fixture",
  codeChanges: [],
  ...patch,
});
function fixture(): UniverseAuditInput {
  // 1: 起点上市；2: 晚于起点+区间上市+覆盖晚；3: 晚于终点上市+覆盖晚。
  // 4: 终点退市；5: 起点前退市；6: 无日期但有行情；7: 仅退市日期(终点后)+区间内改码；8: 无证据+区间外改码。
  const rows = [
    evidence(1, { listingDate: "2020-01-01", localFirstDate: "2020-01-01" }),
    evidence(2, { listingDate: "2020-06-01", localFirstDate: "2020-06-01" }),
    evidence(3, { listingDate: "2021-01-01", localFirstDate: "2021-01-01" }),
    evidence(4, { listingDate: "2010-01-01", delistingDate: "2020-12-31" }),
    evidence(5, { delistingDate: "2019-12-31" }),
    evidence(6, { localFirstDate: "2020-03-01" }),
    evidence(7, {
      delistingDate: "2021-01-01",
      codeChanges: [
        { date: "2020-07-01", source: "映射" },
        { date: "2020-08-01", source: "映射2" },
      ],
    }),
    evidence(8, {
      codeChanges: [
        { date: "2019-12-31", source: "映射" },
        { date: "2021-01-01", source: "映射" },
      ],
    }),
  ];
  return {
    symbols: rows.map((r) => r.symbol),
    source: "合成名单",
    start: "2020-01-01",
    end: "2020-12-31",
    rosterAsOf: null,
    rosterAsOfReason: "未记录",
    rosterIsCurrentSnapshot: true,
    evidence: rows,
  };
}
it("hand counts all seven metrics for eight securities, retaining evidence and unique changed securities", () => {
  const result = auditUniverse(fixture());
  expect(
    Object.fromEntries(
      Object.keys(universeAuditLabels).map((key) => [
        key,
        result[key as keyof typeof universeAuditLabels],
      ]),
    ),
  ).toEqual({
    total: 8,
    notListedAtStart: 2,
    listedDuring: 2,
    delistedDuring: 2,
    codeChanged: 1,
    noEvidence: 2,
    localCoverageStartsAfter: 3,
  });
  expect(result.localCoverageUnknown).toBe(4);
  expect(result.details.codeChanged).toEqual([
    {
      symbol: "sz000007",
      date: "2020-07-01",
      source: "2020-07-01 映射；2020-08-01 映射2",
    },
  ]);
  for (const key of Object.keys(
    universeAuditLabels,
  ) as (keyof typeof universeAuditLabels)[])
    expect(result.details[key]).toHaveLength(result[key]);
});
it("listing exactly at start is already listed", () => {
  const input = fixture();
  input.symbols = ["sz000001"];
  expect(auditUniverse(input).notListedAtStart).toBe(0);
  expect(auditUniverse(input).listedDuring).toBe(1);
});
it("delisting exactly at end is counted and the task's pre-start delisting is retained", () => {
  const result = auditUniverse(fixture());
  expect(result.details.delistedDuring.map((r) => r.date)).toEqual([
    "2020-12-31",
    "2019-12-31",
  ]);
  expect(result.unknowable.delistedDuringIsLowerBound).toBe(true);
});
it("missing lifecycle stays missing even with late local coverage", () => {
  const input = fixture();
  input.symbols = ["sz000006", "sz999999"];
  const result = auditUniverse(input);
  expect(result.noEvidence).toBe(2);
  expect(result.notListedAtStart).toBe(0);
  expect(result.listedDuring).toBe(0);
  expect(result.details.noEvidence.every((r) => r.date === null)).toBe(true);
  expect(result.localCoverageStartsAfter).toBe(1);
});
it("empty pools retain the recorded timestamp and all counts are zero", () => {
  const result = auditUniverse({
    ...fixture(),
    symbols: [],
    rosterAsOf: "2020-12-31T00:00:00Z",
  });
  for (const key of Object.keys(
    universeAuditLabels,
  ) as (keyof typeof universeAuditLabels)[])
    expect(result[key]).toBe(0);
  expect(result.rosterAsOf).toBe("2020-12-31T00:00:00Z");
  expect(result.rosterAsOfReason).toBeNull();
  expect(result.unknowable.delistedDuringIsLowerBound).toBe(true);
});
it("rejects invalid dates and reversed ranges instead of comparing malformed evidence", () => {
  expect(() => auditUniverse({ ...fixture(), start: "2020-02-30" })).toThrow();
  expect(() => auditUniverse({ ...fixture(), end: "2019-01-01" })).toThrow();
  expect(() =>
    auditUniverse({
      ...fixture(),
      evidence: [evidence(1, { listingDate: "garbage" })],
    }),
  ).toThrow();
});

async function localRoot() {
  // The suite setup owns creation, crash cleanup and bounded retention of this temp root.
  const root = join(process.env.QUANT_DATA_DIR!, "v4-source");
  await mkdir(join(root, "T0002", "hq_cache"), { recursive: true });
  await mkdir(join(root, "中证指数"), { recursive: true });
  await copyFile(
    "tests/fixtures/tdx-code-changes.bin",
    join(root, "T0002", "hq_cache", "addedcode_bj.cfg"),
  );
  saveSettings({ ...settings(), tdxRoot: root, industryBlocksRoot: root });
  return root;
}
const range = { start: "2020-01-01", end: "2020-12-31" };
it("service uses real local files/caches with zero remote requests, zero refreshes and zero business writes; pages on server", async () => {
  const root = await localRoot();
  const members = Array.from(
    { length: 25 },
    (_, i) => `sz${String(i + 1).padStart(6, "0")}`,
  );
  const path = join(root, "中证指数", "中证A500.txt");
  await writeFile(path, members.join("\n"));
  await utimes(path, new Date("2020-01-01"), new Date("2020-01-01"));
  put("security-lifecycle", "security-lifecycle-sz000001", {
    version: "security-lifecycle-2",
    symbol: "sz000001",
    source: "fixture",
    fetchedAt: 1,
    evidenceHash: "hash",
    listingDate: "2020-05-01",
    delistingDate: null,
  });
  put("security-lifecycle", "security-lifecycle-sz000002", {
    version: "security-lifecycle-1",
    symbol: "sz000002",
    listingDate: "2020-06-01",
  });
  const fetch = vi.fn(() => {
    throw new Error("禁止 fetch");
  });
  vi.stubGlobal("fetch", fetch);
  const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
  const query = {
    source: { kind: "market", pool: { category: "index", name: "中证A500" } },
    ...range,
    metric: "noEvidence",
  };
  const first = await universeAuditPage(query),
    second = await universeAuditPage({ ...query, page: 1 });
  expect(first.summary.total).toBe(25);
  expect(first.summary.noEvidence).toBe(24);
  expect(first.summary.notListedAtStart).toBe(1);
  expect(first.summary.rosterAsOf).toBeNull();
  expect(first.summary.rosterAsOfReason).toContain("mtime");
  expect(first.summary.localCoverageUnknown).toBe(25);
  expect(first.summary.localCoverageStartsAfter).toBe(0);
  expect(first.rows).toHaveLength(20);
  expect(second.rows).toHaveLength(4);
  expect(second.rows[0]?.symbol).toBe("sz000022");
  expect(second.summary).toEqual(first.summary);
  expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    before,
  );
  expect(await readFile(path, "utf8")).toBe(members.join("\n"));
  // Injection exercises the real service dependency chain; source text alone would miss indirect calls.
  expect(blocked.request).toHaveBeenCalledTimes(0);
  expect(blocked.verify).toHaveBeenCalledTimes(0);
  expect(fetch).toHaveBeenCalledTimes(0);
});
it("TDX read-only roster never creates content-addressed snapshots", async () => {
  const root = await localRoot();
  for (const file of tdxBlockFiles)
    await copyFile(
      `tests/fixtures/tdx-local-blocks/${file}`,
      join(root, "T0002", "hq_cache", file),
    );
  const pool = await readMarketPool(
    root,
    { category: "index", name: "通达信·成分·中证A500" },
    root,
    true,
  );
  expect(get(`market-pool-snapshot-${pool.hash}`)).toBeUndefined();
  const result = await universeAuditPage({
    source: {
      kind: "market",
      pool: { category: "index", name: "通达信·成分·中证A500" },
    },
    ...range,
  });
  expect(result.summary.total).toBe(
    pool.members.filter((s) => s.startsWith("sh") || s.startsWith("sz")).length,
  );
  expect(get(`market-pool-snapshot-${pool.hash}`)).toBeUndefined();
});
it("research audits frozen members including failed stocks, its own root and original interval", async () => {
  const root = await localRoot();
  put("research-task", "research-v4", { id: "research-v4", spec: range });
  put("research-dataset", "research-v4:dataset", {
    root,
    hash: "frozen",
    capturedAt: 1000,
    membership: {
      symbols: ["sz000006", "sz000007"],
      source: { name: "原名单" },
    },
    stocks: [
      { symbol: "sz000006", hash: "stock", bars: [{ date: "2020-03-01" }] },
    ],
  });
  expect(new ResearchStore(sqlite()).dataset("research-v4")).not.toBeNull();
  const result = await universeAuditPage({
    source: { kind: "research", id: "research-v4" },
    ...range,
  });
  expect(result.summary.total).toBe(2);
  expect(result.summary.noEvidence).toBe(2);
  expect(result.summary.notListedAtStart).toBe(0);
  expect(result.summary.localCoverageStartsAfter).toBe(1);
  expect(result.summary.localCoverageUnknown).toBe(1);
  expect(result.summary.rosterAsOf).toBe("1970-01-01T00:00:01.000Z");
  await expect(
    universeAuditPage({
      source: { kind: "research", id: "research-v4" },
      ...range,
      start: "2019-01-01",
    }),
  ).rejects.toThrow("原研究一致");
  expect(blocked.verify).not.toHaveBeenCalled();
  expect(blocked.request).not.toHaveBeenCalled();
});
it("concept audits stored result membership, deduplicates overlapping constituents and refuses a stale hash", async () => {
  await localRoot();
  const { day, rows } = industryDay();
  day.industry!.snapshot.category = "concept";
  day.industry!.snapshot.files[1]!.members.push(
    day.industry!.snapshot.files[0]!.members[0]!,
  );
  new RpsStore(sqlite(), "concept").saveDay(day, rows);
  const query = {
    source: {
      kind: "concept",
      date: day.date,
      hash: day.industry!.snapshot.hash,
    },
    start: "2000-01-01",
    end: day.date,
  };
  const result = await universeAuditPage(query);
  expect(result.summary.total).toBe(6);
  expect(result.summary.rosterAsOf).toBeNull();
  await expect(
    universeAuditPage({
      ...query,
      source: { ...query.source, hash: "absent" },
    }),
  ).rejects.toThrow("快照不可得");
  expect(blocked.verify).not.toHaveBeenCalled();
  expect(blocked.request).not.toHaveBeenCalled();
});
it("renders delisting as a lower bound, including zero, and all three pages share the same audit entry", async () => {
  const { details, ...summary } = auditUniverse(fixture());
  const html = renderToStaticMarkup(
    createElement(UniverseAuditResults, {
      data: {
        summary,
        warnings: [],
        metric: "total",
        total: 8,
        rows: details.total,
      },
      page: 0,
      onPage: () => {},
      loading: false,
    }),
  );
  expect(html).toContain("≥ 2 只");
  const { details: emptyDetails, ...emptySummary } = auditUniverse({
    ...fixture(),
    symbols: [],
  });
  expect(
    renderToStaticMarkup(
      createElement(UniverseAuditResults, {
        data: {
          summary: emptySummary,
          warnings: [],
          metric: "total",
          total: 0,
          rows: emptyDetails.total,
        },
        page: 0,
        onPage: () => {},
        loading: false,
      }),
    ),
  ).toContain("≥ 0 只");
  for (const file of [
    "market/market-pool-browser",
    "research/strategy-research-controls",
    "market/concept-rps-controls",
  ])
    expect(await readFile(`src/components/${file}.tsx`, "utf8")).toContain(
      "<UniverseAuditContainer",
    );
  const router = await readFile("src/server/api/root.ts", "utf8");
  expect(router).toMatch(
    /universeAuditPage: p[\s\S]*?\.input\(universeAuditQuerySchema\)[\s\S]*?universeAuditPage\(input\)/,
  );
});

it("all-market audit only reads the matching cached directory and deduplicates existing coverage/index members", async () => {
  const root = await localRoot();
  put("security-directory", "security-directory", {
    root: `${root}-other`,
    entries: { sz000008: {} },
  });
  const query = { source: { kind: "market", pool: null }, ...range };
  await expect(universeAuditPage(query)).rejects.toThrow("无既有证券主档");
  put("security-directory", "security-directory", {
    root,
    entries: { sz000008: {}, bj920001: {} },
  });
  put("coverage", "coverage", {
    root,
    securities: [
      { symbol: "sz000008", period: "day" },
      { symbol: "sz000009", period: "day" },
      { symbol: "sz000010", period: "5m" },
    ],
  });
  const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
  const result = await universeAuditPage(query);
  expect(result.rows.map((row) => row.symbol)).toEqual([
    "sz000008",
    "sz000009",
  ]);
  expect(result.summary.localCoverageUnknown).toBe(2);
  expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    before,
  );
});
