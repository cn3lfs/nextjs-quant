import { expect, it } from "vitest";
import {
  coverageAllowsPublication,
  estimateRpsSecurity,
} from "../../src/server/screening/rps-observation-job";
import { parseWorkflowQuote } from "../../src/server/jobs/workflow-quotes";
import { claimWorkflow } from "../../src/server/jobs/workflow-lease";
import { latestRpsObservation } from "../../src/server/screening/rps-observation";
import { requiresDownloadReceipt } from "../../src/server/jobs/workflow-scheduler";
import { put } from "../../src/server/db/index";
it("waits for a download receipt only for the close batch", () => {
  // Noon and late estimate today's bar from online quotes, so a redundant noon
  // download must not be able to block them.
  expect(requiresDownloadReceipt("close")).toBe(true);
  expect(requiresDownloadReceipt("noon")).toBe(false);
  expect(requiresDownloadReceipt("late")).toBe(false);
});
it("requires 90 percent new prices without rounding the threshold", () => {
  expect(coverageAllowsPublication(899, 1000)).toBe(false);
  expect(coverageAllowsPublication(900, 1000)).toBe(true);
  expect(coverageAllowsPublication(0, 0)).toBe(false);
});
it("carries the last adjusted close without fabricating an ex-dividend jump", () => {
  const bars = [
    {
      date: "2026-09-09",
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 100,
      amount: 1000,
    },
  ];
  const result = estimateRpsSecurity(
    "sh600000",
    "浦发银行",
    bars,
    [],
    "2026-09-11",
    "2025-01-01",
  );
  expect(result.closes.get("2026-09-11")).toEqual(
    result.closes.get("2026-09-09"),
  );
  expect(
    estimateRpsSecurity(
      "sh600000",
      "浦发银行",
      [],
      [],
      "2026-09-11",
      "2025-01-01",
    ).closes.has("2026-09-11"),
  ).toBe(false);
});
it("rejects wrong symbols, stale dates and old quotes; converts explicit volume units", () => {
  const raw = {
    BaseInfo: { Code: "600000", Setcode: 1, Unit: 100 },
    HQInfo: { HQDate: "20260911", HQTime: "112959", Now: 10, Volume: 123 },
  };
  const now = Date.parse("2026-09-11T12:30:00+08:00");
  expect(parseWorkflowQuote(raw, "sh600000", "2026-09-11", now).volume).toBe(
    12300,
  );
  expect(() =>
    parseWorkflowQuote(raw, "sh600519", "2026-09-11", now),
  ).toThrow();
  expect(() =>
    parseWorkflowQuote(raw, "sh600000", "2026-09-10", now),
  ).toThrow();
  expect(() =>
    parseWorkflowQuote(
      { ...raw, HQInfo: { ...raw.HQInfo, HQTime: "100000" } },
      "sh600000",
      "2026-09-11",
      now,
    ),
  ).toThrow();
});
it("shares one lease across desktop and headless claimants", () => {
  const first = claimWorkflow("test-observation");
  expect(first).not.toBeNull();
  expect(claimWorkflow("test-observation")).toBeNull();
  first!.assert();
  first!.release();
  const next = claimWorkflow("test-observation");
  expect(next).not.toBeNull();
  next!.release();
});
it("does not select a future noon ranking for morning screening", () => {
  const root = "D:/test-root",
    morning = Date.parse("2026-09-11T11:20:00+08:00");
  put("rps-observation", "future-batch", {
    id: "future-batch",
    root,
    createdAt: morning + 3600000,
  });
  expect(latestRpsObservation(root, morning)).toBeNull();
});
import { readFileSync } from "node:fs";
import { parseTencentWorkflowQuotes } from "../../src/server/jobs/workflow-quotes";
it("parses a real Tencent batch without evaluating JavaScript and keeps missing rows explicit", () => {
  const raw = readFileSync(
    "tests/fixtures/tencent-quotes-20260911.txt",
    "utf8",
  );
  const symbols = ["sh600000", "sh600519", "sz000001"];
  const prices = parseTencentWorkflowQuotes(
    raw,
    symbols,
    "2026-09-11",
    Date.parse("2026-09-11T12:59:00+08:00"),
  );
  expect(prices.map((row) => row.symbol)).toEqual(symbols);
  expect(prices[0]).toMatchObject({
    price: 9.28,
    volume: 42670600,
    source: "tencent-quotes",
  });
  expect(
    parseTencentWorkflowQuotes(
      raw,
      symbols,
      "2026-09-10",
      Date.parse("2026-09-11T12:59:00+08:00"),
    ),
  ).toEqual([]);
  expect(() =>
    parseTencentWorkflowQuotes(
      raw + raw,
      symbols,
      "2026-09-11",
      Date.parse("2026-09-11T12:59:00+08:00"),
    ),
  ).toThrow("重复");
});
