import { expect, it } from "vitest";
import { onlineChartSnapshot } from "../src/server/online-chart-data";
import { commonIndices } from "../src/lib/market-indices";

it.skipIf(!process.env.QUANT_ONLINE_INDEX_AUDIT)(
  "online index daily bars are available independently of local files",
  async () => {
    for (const row of [
      ...commonIndices,
      { symbol: "sh000510", name: "中证A500" },
      { symbol: "sh000688", name: "科创50" },
      { symbol: "sz399005", name: "中小100" },
    ]) {
      const snapshot = await onlineChartSnapshot(row.symbol, "day");
      expect(snapshot.symbol).toBe(row.symbol);
      expect(snapshot.source).toBe("eastmoney-online");
      expect(snapshot.bars.length).toBeGreaterThan(100);
      expect(snapshot.bars.at(-1)!.close).toBeGreaterThan(0);
    }
  },
  120000,
);
