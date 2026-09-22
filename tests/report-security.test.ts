import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { put, get } from "../src/server/db";
import { reportSecurityContext } from "../src/server/research/report-security";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-report-security-"),
);

it("resolves saved snapshot, backtest and signal links without rewriting evidence", () => {
  const snapshot = {
    symbol: "sh603607",
    name: "归档旧名",
    bars: [{ close: 123 }],
  };
  put("snapshot", "source", snapshot);
  put("job", "backtest", { type: "backtest", input: { snapshotId: "source" } });
  put("signal", "signal", { symbol: snapshot.symbol, snapshotId: "source" });
  for (const id of ["source", "backtest", "signal"])
    expect(reportSecurityContext(id)).toEqual({
      symbol: snapshot.symbol,
      archivedName: snapshot.name,
    });
  expect(get("source")).toEqual(snapshot);
});
it("does not infer securities from untrusted text, unknown contexts or conflicting links", () => {
  put("report", "prose", {
    symbol: "sh600519",
    title: "贵州茅台",
    contextId: "source",
  });
  put("job", "screen", { type: "screen", input: { snapshotId: "source" } });
  put("signal", "conflict", { symbol: "sz000001", snapshotId: "source" });
  put("snapshot", "invalid", { symbol: "600519" });
  for (const id of ["prose", "screen", "conflict", "invalid", "missing"])
    expect(reportSecurityContext(id)).toBeNull();
});
it("preserves a valid signal identity when its old snapshot is unavailable", () => {
  put("signal", "old-signal", {
    symbol: "sz000001",
    snapshotId: "unavailable",
  });
  expect(reportSecurityContext("old-signal")).toEqual({
    symbol: "sz000001",
    archivedName: undefined,
  });
});
