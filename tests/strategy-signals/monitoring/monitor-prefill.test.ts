import { expect, it } from "vitest";
import {
  monitorPrefillHref,
  monitorSymbolLimit,
  readMonitorPrefill,
} from "~/lib/strategy-facts/monitor-workspace-draft";

it("round-trips a screening list into a new-subscription link", () => {
  const href = monitorPrefillHref({
    name: "选股候选 2026-09-28",
    symbols: ["sh600519", "sz000001"],
  });
  const url = new URL(href, "http://x");
  expect(url.pathname).toBe("/signals");
  expect(url.searchParams.get("monitorTab")).toBe("monitors");
  expect(readMonitorPrefill(url.searchParams.get("monitorNew"))).toEqual({
    name: "选股候选 2026-09-28",
    symbols: ["sh600519", "sz000001"],
  });
});

it("refuses lists a subscription could not hold and malformed input", () => {
  const many = Array.from(
    { length: monitorSymbolLimit + 1 },
    (_, i) => `sz${String(i).padStart(6, "0")}`,
  );
  expect(() => monitorPrefillHref({ name: "x", symbols: many })).toThrow();
  expect(() =>
    monitorPrefillHref({ name: "x", symbols: ["600519"] }),
  ).toThrow();
  expect(readMonitorPrefill(null)).toBeNull();
  expect(readMonitorPrefill("{")).toBeNull();
  expect(
    readMonitorPrefill(JSON.stringify({ name: "x", symbols: many })),
  ).toBeNull();
  expect(readMonitorPrefill("x".repeat(5000))).toBeNull();
});
