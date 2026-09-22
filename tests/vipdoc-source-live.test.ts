import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { readSnapshot } from "../src/server/data-sources/tdx/tdx";
import { aggregateChartBars } from "../src/server/market/chart-aggregation";

it.skipIf(!process.env.QUANT_VIPDOC_ACCEPTANCE_ROOT)(
  "本地文件完整解析与周期聚合逐项记录",
  async () => {
    const results = [];
    for (const symbol of [
      "sh600000",
      "sz000001",
      "sz300750",
      "sh688981",
      "bj920002",
      "sh000001",
      "sz399006",
      "sh510300",
      "sz159915",
      "sh880001",
    ])
      for (const period of ["day", "week", "5m"] as const) {
        try {
          const snapshot = await readSnapshot(
            process.env.QUANT_VIPDOC_ACCEPTANCE_ROOT!,
            symbol,
            period === "5m" ? "5m" : "day",
            { chartFunds: true },
          );
          const bars =
            period === "week"
              ? aggregateChartBars(snapshot.bars, "day", "week", Date.now())
                  .bars
              : snapshot.bars;
          results.push({
            symbol,
            period,
            status: "ok",
            count: bars.length,
            last: bars.at(-1),
            hash: snapshot.hash,
            source: snapshot.source,
          });
        } catch (error) {
          results.push({
            symbol,
            period,
            status:
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "missing-file"
                : "invalid",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    if (process.env.QUANT_VIPDOC_REPORT)
      await writeFile(
        process.env.QUANT_VIPDOC_REPORT,
        JSON.stringify(results, null, 2),
      );
    // 检查的是按项产出；完整源文件错误必须留在报告，不能据此称全部行情可用。
    expect(results).toHaveLength(30);
    for (const result of results)
      if (result.status === "ok") expect(result.count).toBeGreaterThan(0);
  },
  120000,
);
