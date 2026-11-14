import { expect, it } from "vitest";
import { get } from "../../../src/server/db/index";
import { readBars } from "../../../src/server/market/bar-store/read-bars";
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { readBenchmarkSnapshot } from "../../../src/server/data-sources/tdx/tdx-benchmark";
import { localRpsDependencies } from "../../../src/server/screening/rps-job";
import {
  publishFullDayPackage,
  readFullDaySnapshot,
} from "../../../src/server/market/bar-store/package-import";
const file = "tests/fixtures/tdx-full-day/valid.zip";
it
  .skipIf(process.platform !== "win32")
  .each(["", resolve(process.env.QUANT_DATA_DIR!, "missing-source-root")])(
  "uses the imported benchmark when no local index file exists",
  async (root) => {
    const [source] = await publishFullDayPackage(
      "tests/fixtures/tdx-full-day/with-index.zip",
      ["sh000001"],
      100,
    );
    const result = await readBenchmarkSnapshot(
      root,
      "2026-09-11",
      "2026-09-11",
    );
    expect(result.source).toBe("tdx-full-package");
    expect(result.dataRoot).toBe(root);
    expect(result.bars[0]?.close).toBe(11);
    expect(result.sourceVersions).toEqual([source!.id]);
    await expect(
      readBenchmarkSnapshot(root, "2026-09-12", "2026-09-11"),
    ).rejects.toThrow("区间");
  },
);
it.skipIf(process.platform !== "win32")(
  "publishes immutable histories and preserves the current batch on missing symbols or stale attempts",
  async () => {
    const root = "";
    const [first] = await publishFullDayPackage(file, ["sh600000"], 100);
    expect(first?.bars[0]?.close).toBe(11);
    await publishFullDayPackage(
      "tests/fixtures/tdx-full-day/with-index.zip",
      ["sh000001"],
      100,
    );
    const deps = localRpsDependencies(root, []);
    expect(deps.root).toBe(root);
    expect(await deps.universe()).toContainEqual({
      symbol: "sh600000",
      name: "sh600000",
    });
    expect(await deps.calendar()).toMatchObject({ days: ["2026-09-11"] });
    expect(deps.incrementSnapshots?.()).toContain(
      readFullDaySnapshot("sh000001")!.id,
    );
    const worker = new Worker(resolve("runtime/worker.cjs"));
    try {
      const result = await new Promise<unknown>((resolveResult, reject) => {
        worker.once("error", reject);
        worker.once(
          "message",
          (message: { result?: unknown; error?: string }) =>
            message.error
              ? reject(new Error(message.error))
              : resolveResult(message.result),
        );
        worker.postMessage({
          type: "snapshot",
          root: root,
          symbol: "sh600000",
          period: "day",
        });
      });
      expect(result).toMatchObject({
        source: "tdx-full-package",
        dataRoot: root,
        hash: first?.hash,
      });
    } finally {
      await worker.terminate();
    }
    expect(
      await readBars({
        instrument: { market: "cn-equity", symbol: "sh600000" },
        root,
        period: "day",
        adjustment: "none",
      }),
    ).toMatchObject({
      source: "tdx-full-package",
      dataRoot: root,
      hash: first?.hash,
      bars: first?.bars,
    });
    expect(readFullDaySnapshot("sh600000")?.id).toBe(first?.id);
    expect(
      (await publishFullDayPackage(file, ["sh600000"], 101))[0]?.createdAt,
    ).toBe(100);
    await expect(
      publishFullDayPackage(file, ["sz000001", "sh600001"], 102),
    ).rejects.toThrow("缺少");
    expect(readFullDaySnapshot("sz000001")).toBeNull();
    await expect(
      publishFullDayPackage(file, ["sz000001", "sh600000"], 99),
    ).rejects.toThrow("更新");
    expect(readFullDaySnapshot("sz000001")).toBeNull();
    await expect(publishFullDayPackage(file, ["sh600000"], 99)).rejects.toThrow(
      "更新",
    );
    expect(get(first!.id)).toBeUndefined(); // New imports persist columns, not bars JSON records.
    expect(readFullDaySnapshot("sh600000")?.id).toBe(first?.id);
  },
);
