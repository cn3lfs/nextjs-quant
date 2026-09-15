import { expect, it } from "vitest";
import { put } from "../src/server/db";
import {
  publishFullDayPackage,
  readFullDaySnapshot,
} from "../src/server/tdx-full-day-cache";

it.skipIf(process.platform !== "win32")(
  "旧两位精度基金缓存不可复用，新导入与本地文件精度一致",
  async () => {
    put("tdx-full-day-snapshot", "old-etf", {
      id: "old-etf",
      symbol: "sh510300",
      period: "day",
      source: "tdx-full-package",
      bars: [{ date: "2026-09-11", close: 45.79 }],
      sourceVersions: ["old-etf"],
    });
    put("tdx-full-day-current", "tdx-full-day-current-sh510300", {
      snapshotId: "old-etf",
      importedAt: 1,
    });
    expect(readFullDaySnapshot("sh510300")).toBeNull();
    const snapshots = await publishFullDayPackage(
      "tests/fixtures/tdx-full-day/with-etf.zip",
      ["sh510300", "sz159915"],
      2,
    );
    expect(snapshots.map((row) => row.bars.at(-1)!.close)).toEqual([
      4.579, 3.341,
    ]);
    expect(readFullDaySnapshot("sh510300")!.sourceVersions).toContain(
      "tdx-full-day-fund-3-v1",
    );
  },
);
