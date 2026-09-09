import { z } from "zod";
import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "~/lib/domain";
import { get, put } from "./db";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "./evidence";
import { sharedRead } from "./shared-read";
const shared = sharedRead<{
  archive: ReturnType<typeof priceRsSnapshot>;
  captured: number;
}>();
const table = z.object({
  status_code: z.literal(0),
  code_count: z.number().int().min(1).max(20000),
  datas: z.array(z.record(z.unknown())),
  columns: z.array(
    z.object({
      key: z.string(),
      unit: z.string().optional(),
      timestamp: z.string().optional(),
      type: z.string().optional(),
    }),
  ),
});
export function priceRsSnapshot(raw: unknown, start: string, end: string) {
  for (const value of [start, end])
    if (!/^\d{8}$/.test(value)) throw new Error("价格RS日期非法");
  if (start >= end) throw new Error("价格RS日期顺序非法");
  const source = table.parse(raw);
  if (source.datas.length !== source.code_count)
    throw new Error("价格RS列表未完整返回");
  const keys = [start, end].map((date) => `收盘价_不复权[${date}]`);
  for (const [i, key] of keys.entries())
    if (
      source.columns.filter(
        (c) =>
          c.key === key &&
          c.timestamp === [start, end][i] &&
          c.unit === "元" &&
          c.type === "DOUBLE",
      ).length !== 1
    )
      throw new Error("价格RS字段口径不明确");
  const rows: Array<{
    code: string;
    startClose: number;
    endClose: number;
    change: number;
  }> = [];
  const excluded: Array<{ code: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const row of source.datas) {
    validateHithinkColumns(row, source.columns);
    const code = row["股票代码"];
    if (
      typeof code !== "string" ||
      !/^\d{6}\.(SH|SZ|BJ)$/.test(code) ||
      seen.has(code)
    )
      throw new Error("价格RS证券身份重复或非法");
    seen.add(code);
    const values = keys.map((key) => row[key]);
    if (
      values.some(
        (v) =>
          v == null ||
          v === "--" ||
          !Number.isFinite(Number(v)) ||
          Number(v) <= 0,
      )
    ) {
      excluded.push({ code, reason: "缺少有效正数端点收盘价" });
      continue;
    }
    const [a, b] = values.map(Number) as [number, number];
    const change = (b / a - 1) * 100;
    if (!Number.isFinite(change)) throw new Error("价格RS收益非法");
    rows.push({ code, startClose: a, endClose: b, change });
  }
  rows.sort((a, b) => b.change - a.change || a.code.localeCompare(b.code));
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: "price-rs-1", start, end, source }))
    .digest("hex");
  return {
    id: `rs-prices-${hash}`,
    hash,
    version: "price-rs-1",
    range: `${start}-${end}`,
    start,
    end,
    count: rows.length,
    declaredCount: source.code_count,
    rows,
    excluded,
    source,
  };
}
export function priceRsEvidence(
  stock: Snapshot,
  archive: ReturnType<typeof priceRsSnapshot>,
  fetchedAt: number,
): Evidence {
  const target = archive.rows.find(
    (r) =>
      r.code ===
      `${stock.symbol.slice(2)}.${stock.symbol.slice(0, 2).toUpperCase()}`,
  );
  const bars = stock.bars.slice(-61),
    start = bars[0],
    end = bars.at(-1);
  if (
    stock.period !== "day" ||
    bars.length !== 61 ||
    !start ||
    !end ||
    start.date.replaceAll("-", "") !== archive.start ||
    end.date.replaceAll("-", "") !== archive.end ||
    bars.some((b, i) => i > 0 && b.date <= bars[i - 1]!.date)
  )
    throw new Error("价格RS与本地窗口不一致");
  const above = target
    ? archive.rows.filter((r) => r.change > target.change).length
    : 0;
  const equal = target
    ? archive.rows.filter((r) => r.change === target.change).length
    : 0;
  const endpointPricesMatch =
    !!target &&
    Math.abs(target.startClose - start.close) < 0.005 &&
    Math.abs(target.endClose - end.close) < 0.005;
  const warnings = [
    "仅来源返回列表中具备两个端点正数不复权收盘价的证券排名，日期查询可能隐含过滤，不等于独立完整A股或历史证券池。",
    "收益由JS用期末收盘价/期初收盘价-1计算，不使用来源区间涨幅字段；并列采用中位名次。",
    "60个本地记录间隔未证明期间无缺失交易日；此排名不直接解除SEPA的全市场RS85门禁。",
    ...(!endpointPricesMatch
      ? [
          "目标未在有效价格池中，或来源与本地端点收盘价不一致，禁止合并趋势判断。",
        ]
      : []),
  ];
  const payload = {
    version: "price-rs-evidence-1",
    symbol: stock.symbol,
    snapshotId: archive.id,
    snapshotHash: archive.hash,
    stockSnapshotId: stock.id,
    stockSnapshotHash: stock.hash,
    range: archive.range,
    declaredCount: archive.declaredCount,
    eligibleCount: archive.count,
    excludedCount: archive.excluded.length,
    endpointPricesMatch,
    target: target ?? null,
    midRank: target ? above + (equal + 1) / 2 : null,
    percentile:
      target && archive.count > 1
        ? (1 - (above + (equal - 1) / 2) / (archive.count - 1)) * 100
        : null,
    warnings,
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-astock-selector/price-rs",
    symbol: stock.symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: "CNY",
    unit: { close: "元", change: "%", percentile: "%" },
    adjustment: "none",
    reportPeriod: null,
    quality: "partial",
    warnings,
  });
  return {
    id: `price-rs-${envelope.payloadHash.slice(0, 16)}`,
    source: "端点价格自算RS（来源有效价格池）",
    asOf: archive.range,
    text: JSON.stringify(payload),
    envelope,
  };
}
export async function queryPriceRsEvidence(
  stock: Snapshot,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (stock.historicalAsOf || stock.period !== "day" || stock.bars.length < 61)
    throw new Error("价格RS需要非历史模式的61条日线");
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  const start = stock.bars.at(-61)!.date.replaceAll("-", ""),
    end = stock.bars.at(-1)!.date.replaceAll("-", "");
  const key = `price-rs-cache-1-${start}-${end}`;
  const pointer = get<{ id: string; fetchedAt: number }>(key);
  let captured = pointer?.fetchedAt ?? 0;
  let archive =
    pointer && Date.now() - captured >= 0 && Date.now() - captured < 30000
      ? get<ReturnType<typeof priceRsSnapshot>>(pointer.id)
      : undefined;
  if (!archive) {
    const loaded = await shared(
      key,
      async (sharedSignal) => {
        const raw = await request(
          "hithink-astock-selector",
          `全部A股 ${start}不复权收盘价 ${end}不复权收盘价`,
          sharedSignal,
          1,
          10000,
        );
        sharedSignal.throwIfAborted();
        const result = priceRsSnapshot(raw, start, end);
        const observedAt = Date.now();
        if (!get(result.id))
          put("rs-universe", result.id, { ...result, capturedAt: observedAt });
        put("cache", key, { id: result.id, fetchedAt: observedAt });
        return { archive: result, captured: observedAt };
      },
      signal,
    );
    archive = loaded.archive;
    captured = loaded.captured;
  }
  signal?.throwIfAborted();
  return priceRsEvidence(stock, archive, captured);
}
