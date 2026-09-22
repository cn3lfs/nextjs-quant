import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { eastmoneyKlines } from "../src/server/data-sources/eastmoney/eastmoney-adapter";

it.skipIf(process.env.QUANT_EASTMONEY_ACCEPTANCE !== "1")(
  "东方财富各品种日周分钟真实验收",
  async () => {
    const results = [];
    for (const period of ["day", "week", "5m"] as const)
      results.push(
        await eastmoneyKlines({
          symbols: [
            "sh600000",
            "sz000001",
            "sz300750",
            "sh688981",
            "bj920002",
            "sh000001",
            "sz399006",
            "sh510300",
            "sz159915",
            "emBK0475",
          ],
          period,
          limit: 3,
        }),
      );
    if (process.env.QUANT_EASTMONEY_REPORT)
      await writeFile(
        process.env.QUANT_EASTMONEY_REPORT,
        JSON.stringify(results, null, 2),
      );
    for (const result of results) {
      expect(result.items.map((item) => item.status)).toEqual(
        Array(10).fill("ok"),
      );
      for (const item of result.items)
        if (item.status === "ok") expect(item.bars).toHaveLength(3);
    }
  },
  180000,
);
