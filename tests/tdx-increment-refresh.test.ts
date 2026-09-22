import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { refreshDailyIncrement } from "../src/server/data-sources/tdx/tdx-increment-refresh";
import { readDailyIncrement } from "../src/server/data-sources/tdx/tdx-daily-cache";

it.skipIf(process.platform !== "win32")(
  "rolls back all markets when a later market is incomplete, then publishes a complete selected batch",
  async () => {
    const bytes = readFileSync("tests/fixtures/tdx-daily-increment/sample.zip");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    try {
      await expect(
        refreshDailyIncrement("2026-09-10", ["sh600519", "sz000001"]),
      ).rejects.toThrow("未齐备");
      expect(readDailyIncrement("sh600519", "2026-09-10")).toBeNull();
      const result = await refreshDailyIncrement("2026-09-10", ["sh600519"]);
      expect(result.status).toBe("published");
      expect(
        readDailyIncrement("sh600519", "2026-09-10")?.record.bar.close,
      ).toBe(11);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
