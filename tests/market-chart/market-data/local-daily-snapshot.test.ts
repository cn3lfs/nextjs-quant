import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { put } from "~/server/db";
import { writeColumnCache } from "~/server/market/bar-store/column-cache";
import { readBars } from "~/server/market/bar-store/read-bars";
import type { Snapshot } from "~/lib/domain";

/** Actual caches and TDX bytes exercise source selection and same-date repair. */
it("requires explicit repair, returns to newer local data and retains imported provenance", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "selection-source"),
    file = join(root, "vipdoc/sh/lday/sh600000.day");
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  const bytes = (date: number) => {
    const b = Buffer.alloc(32);
    b.writeUInt32LE(date);
    for (const off of [4, 8, 12, 16]) b.writeUInt32LE(1000, off);
    return b;
  };
  await writeFile(file, bytes(20260911));
  const imported: Snapshot = {
    id: "import-selection",
    symbol: "sh600000",
    period: "day",
    source: "tdx-full-package",
    hash: "imported",
    adjustment: "none",
    createdAt: 10,
    sourceVersions: ["version"],
    bars: [
      {
        date: "2026-09-11",
        open: 11,
        high: 11,
        low: 11,
        close: 11,
        volume: 0,
        amount: 0,
      },
    ],
  };
  const { bars, ...metadata } = imported;
  writeColumnCache(
    `full-package:${imported.id}`,
    bars,
    imported.hash,
    metadata,
  );
  put("tdx-full-day-current", "tdx-full-day-current-sh600000", {
    snapshotId: imported.id,
    importedAt: 10,
  });
  const input = {
    instrument: { market: "cn-equity" as const, symbol: "sh600000" },
    root,
    period: "day" as const,
    adjustment: "none" as const,
  };
  expect((await readBars(input)).source).toBe("tdx-local");
  put("tdx-full-day-current", "tdx-full-day-current-sh600000", {
    snapshotId: imported.id,
    importedAt: 10,
    repairSameDate: true,
  });
  expect((await readBars(input)).bars[0]?.close).toBe(11);
  put("tdx-full-day-current", "tdx-full-day-current-sh600000", {
    snapshotId: imported.id,
    importedAt: 10,
  });
  await writeFile(file, bytes(20260910));
  expect((await readBars(input)).source).toBe("tdx-full-package");
  await writeFile(file, bytes(20260914));
  expect((await readBars(input)).source).toBe("tdx-local");
  expect(
    await readBars({ ...input, root: join(root, "missing") }),
  ).toMatchObject({
    source: "tdx-full-package",
    hash: "imported",
    sourceVersions: ["version"],
  });
});
