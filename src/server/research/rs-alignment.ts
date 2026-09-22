import { z } from "zod";
import type { Evidence, Snapshot } from "~/lib/domain";
import { evidenceEnvelope } from "../infra/evidence";
const rank = z.object({
  version: z.literal("rs-full-list-1"),
  symbol: z.string(),
  range: z.string().regex(/^\d{8}-\d{8}$/),
  universeCount: z.number().int().min(2),
  change: z.number().finite(),
  percentile: z.number().min(0).max(100),
  verified: z.literal(true),
  snapshotId: z.string().regex(/^rs-universe-[a-f0-9]{64}$/),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export function rsAlignmentEvidence(
  source: Snapshot,
  evidence: Evidence,
): Evidence {
  const rs = rank.parse(JSON.parse(evidence.text));
  if (
    evidence.envelope?.source !== "hithink-astock-selector/rs" ||
    rs.symbol !== source.symbol ||
    rs.snapshotId !== `rs-universe-${rs.snapshotHash}`
  )
    throw new Error("RS核验来源身份或指纹不一致");
  const iso = (value: string) =>
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  const [start, end] = rs.range.split("-").map(iso) as [string, string];
  if (
    [start, end].some(
      (value) =>
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value,
    ) ||
    start >= end
  )
    throw new Error("RS核验区间非法");
  const window = source.bars.filter(
    (bar) => bar.date >= start && bar.date <= end,
  );
  const daily = source.period === "day";
  const ordered = window.every(
    (bar, i) => i === 0 || bar.date > window[i - 1]!.date,
  );
  const endpointMatch =
    daily &&
    ordered &&
    window[0]?.date === start &&
    window.at(-1)?.date === end;
  const latestMatch = daily && source.bars.at(-1)?.date === end;
  const sixtyIntervals = endpointMatch && window.length === 61;
  const localChange =
    endpointMatch && window[0]!.close > 0
      ? (window.at(-1)!.close / window[0]!.close - 1) * 100
      : null;
  const returnDifference =
    localChange === null ? null : localChange - rs.change;
  const returnMatches =
    returnDifference !== null &&
    Number.isFinite(returnDifference) &&
    Math.abs(returnDifference) <= 0.01;
  const comparable =
    endpointMatch && latestMatch && sixtyIntervals && returnMatches;
  const payload = {
    version: "rs-alignment-1",
    symbol: source.symbol,
    stockSnapshotId: source.id,
    stockSnapshotHash: source.hash,
    rsEvidenceId: evidence.id,
    rsSnapshotId: rs.snapshotId,
    rsSnapshotHash: rs.snapshotHash,
    start,
    end,
    localLatest: source.bars.at(-1)?.date ?? null,
    recordsInRange: window.length,
    endpointMatch,
    latestMatch,
    sixtyIntervals,
    localChange,
    sourceChange: rs.change,
    returnDifference,
    returnMatches,
    comparable,
    sourcePercentile: rs.percentile,
    warnings: [
      ...(!endpointMatch ? ["本地日线没有完整覆盖RS来源的相同起止日期。"] : []),
      ...(!latestMatch
        ? ["本地最新行情与RS截止日不同，不得跨时点合并趋势判断。"]
        : []),
      ...(!sixtyIntervals ? ["未确认同区间恰有60个本地收益间隔。"] : []),
      ...(!returnMatches
        ? ["本地与来源同区间涨幅未能在0.01个百分点内一致核验。"]
        : []),
      "比较采用本地不复权收盘价；来源复权口径、期间缺失交易日与历史成分可用性仍需独立核验。",
      "此结果只核对窗口与数值一致性，不直接解除SEPA相对强度门禁。",
    ],
  };
  const envelope = evidenceEnvelope(payload, {
    source: "sepa-rs-alignment",
    symbol: source.symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt: evidence.envelope.fetchedAt,
    currency: null,
    unit: { returnDifference: "百分点" },
    adjustment: "unknown",
    reportPeriod: null,
    quality: "partial",
    warnings: payload.warnings,
  });
  return {
    id: `rs-alignment-${envelope.payloadHash.slice(0, 16)}`,
    source: "RS与本地行情窗口核验",
    asOf: `${start} 至 ${end}`,
    text: JSON.stringify(payload),
    envelope,
  };
}
