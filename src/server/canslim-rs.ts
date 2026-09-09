import { createHash } from "node:crypto";
import { z } from "zod";
import type { Evidence, Snapshot } from "~/lib/domain";
export function canslimRs(stock: Snapshot, evidence: Evidence) {
  if (
    evidence.envelope?.source !== "hithink-astock-selector/price-rs" ||
    evidence.envelope.symbol !== stock.symbol ||
    createHash("sha256").update(evidence.text).digest("hex") !==
      evidence.envelope.payloadHash
  )
    throw new Error("RS证据身份或内容校验失败");
  const raw = z
    .object({
      version: z.literal("price-rs-evidence-1"),
      symbol: z.string(),
      stockSnapshotId: z.string(),
      stockSnapshotHash: z.string(),
      snapshotId: z.string(),
      range: z.string(),
      endpointPricesMatch: z.boolean(),
      percentile: z.number().finite().min(0).max(100).nullable(),
      eligibleCount: z.number().int().nonnegative(),
      declaredCount: z.number().int().positive(),
      excludedCount: z.number().int().nonnegative(),
    })
    .parse(JSON.parse(evidence.text));
  if (
    raw.symbol !== stock.symbol ||
    raw.stockSnapshotId !== stock.id ||
    raw.stockSnapshotHash !== stock.hash ||
    stock.period !== "day" ||
    stock.bars.length < 61 ||
    raw.range !==
      `${stock.bars.at(-61)!.date.replaceAll("-", "")}-${stock.bars.at(-1)!.date.replaceAll("-", "")}` ||
    raw.eligibleCount + raw.excludedCount !== raw.declaredCount
  )
    throw new Error("RS窗口或证券池计数不一致");
  const percentile = raw.endpointPricesMatch ? raw.percentile : null;
  const provisionalPoints =
    percentile === null
      ? null
      : percentile >= 95
        ? 9
        : percentile >= 90
          ? 7
          : percentile >= 80
            ? 5
            : percentile >= 70
              ? 2
              : 0;
  return {
    id: "L1",
    maxPoints: 9,
    version: "canslim-rs-1",
    status: "missing" as const,
    points: 0,
    poolPercentile: percentile,
    provisionalPoints,
    poolSnapshotId: raw.snapshotId,
    eligibleCount: raw.eligibleCount,
    excludedCount: raw.excludedCount,
    evidenceIds: [evidence.id],
    reason:
      "来源有效价格池百分位仅作观察；独立全市场证券池、交易日完整性、停复牌及企业行动可比性未核验，不将池内分档贡献为全市场L1得分。",
  };
}
