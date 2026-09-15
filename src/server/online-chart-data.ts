import { createHash } from "node:crypto";
import type { Period, Snapshot } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";
import { eastmoneyKlines } from "./eastmoney-adapter";
export { parseOnlineChart } from "./eastmoney-bars";

export async function onlineChartSnapshot(
  symbol: string,
  period: Period,
): Promise<Snapshot> {
  symbolSchema.parse(symbol);
  const result = await eastmoneyKlines({
    symbols: [symbol],
    period,
    limit: 20000,
  });
  const item = result.items[0]!;
  if (item.status !== "ok") throw new Error(item.message);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        symbol,
        period,
        version: result.version,
        adjustment: result.adjustment,
        bars: item.bars,
      }),
    )
    .digest("hex");
  return {
    id: `snapshot-online-${symbol}-${period}-${hash.slice(0, 16)}`,
    symbol,
    name: item.name,
    period,
    source: result.source,
    adjustment: "none",
    createdAt: Date.now(),
    bars: item.bars,
    hash,
    sourceUrl: item.sourceUrl,
    volumeUnit: result.volumeUnit,
    sourceNote: `${result.version}；${result.warnings.join("；")}`,
  };
}
