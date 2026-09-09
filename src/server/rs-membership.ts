import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { request } from "./hithink-context";
import { get } from "./db";
import { priceRsSnapshot } from "./price-rs";
import { evidenceEnvelope } from "./evidence";
import { sharedRead } from "./shared-read";
const table = z.object({
  status_code: z.literal(0),
  code_count: z.number().int().positive().max(20000),
  datas: z.array(
    z.object({
      股票代码: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/),
      上市日期: z.unknown().optional(),
    }),
  ),
  columns: z
    .array(z.object({ key: z.string(), type: z.string().optional() }))
    .optional(),
});
export function rsMembershipAudit(
  raw: unknown,
  prices: ReturnType<typeof priceRsSnapshot>,
) {
  const data = table.parse(raw);
  const codes = data.datas.map((r) => r["股票代码"]),
    set = new Set(codes);
  if (codes.length !== data.code_count || set.size !== codes.length)
    throw new Error("独立证券名单未完整返回或存在重复");
  const priceCodes = new Set(
    prices.source.datas.map((r) => r["股票代码"] as string),
  );
  const listingColumns = data.columns?.filter((c) => c.key === "上市日期");
  const listingColumnValid =
    listingColumns?.length === 1 && listingColumns[0]?.type === "DATE";
  const excluded = new Set(prices.excluded.map((item) => item.code));
  const unavailable = data.datas
    .filter(
      (row) => !priceCodes.has(row.股票代码) || excluded.has(row.股票代码),
    )
    .map((row) => {
      const rawDate = row.上市日期;
      const formatted =
        typeof rawDate === "string" && /^\d{8}$/.test(rawDate)
          ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
          : null;
      const time = formatted ? Date.parse(formatted) : NaN;
      const listed =
        listingColumnValid &&
        formatted &&
        Number.isFinite(time) &&
        new Date(time).toISOString().slice(0, 10) === formatted
          ? (rawDate as string)
          : null;
      return {
        code: row.股票代码,
        listingDate: listed,
        location: priceCodes.has(row.股票代码)
          ? "invalid-endpoints"
          : "absent-from-price-query",
        reason:
          listed === null
            ? "上市日期缺失或非法"
            : listed > prices.end
              ? "价格截止日之后上市"
              : listed > prices.start
                ? "价格起始日之后上市，不能计算同区间收益"
                : "起始日已上市但价格缺失，原因待核验",
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    version: "rs-membership-2",
    membershipCodes: codes.sort(),
    membershipCount: codes.length,
    priceDeclaredCount: prices.declaredCount,
    eligibleCount: prices.count,
    priceSnapshotId: prices.id,
    missingFromPrices: codes.filter((c) => !priceCodes.has(c)),
    extraInPrices: [...priceCodes].filter((c) => !set.has(c)).sort(),
    excludedEndpoints: prices.excluded,
    unavailable,
    warnings: [
      "无价格日期条件的当前A股名单与有日期价格池逐代码对比；只按有效上市日期解释是否具备起始日，不把其余缺失标为退市或停牌。",
      "同来源独立查询不能证明历史池或跨来源完整性；即使名单一致，交易日及企业行动可比性仍需核验。",
    ],
  };
}
const shared = sharedRead<unknown>();
export async function queryRsMembershipEvidence(
  rs: Evidence,
  signal?: AbortSignal,
): Promise<Evidence> {
  signal?.throwIfAborted();
  const { snapshotId } = z
    .object({ snapshotId: z.string().regex(/^rs-prices-[a-f0-9]{64}$/) })
    .parse(JSON.parse(rs.text));
  const saved = get<ReturnType<typeof priceRsSnapshot>>(snapshotId);
  if (!saved) throw new Error("RS源档案缺失");
  const prices = priceRsSnapshot(saved.source, saved.start, saved.end);
  if (prices.id !== snapshotId) throw new Error("RS源档案指纹不一致");
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  const raw = await shared(
    "current-a-share-membership-listing-2",
    (upstream) =>
      request(
        "hithink-astock-selector",
        "全部A股 股票代码 股票简称 上市日期",
        upstream,
        1,
        10000,
      ),
    signal,
  );
  signal?.throwIfAborted();
  const payload = rsMembershipAudit(raw, prices);
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-astock-selector/membership-audit",
    symbol: rs.envelope?.symbol ?? null,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt: Date.now(),
    currency: null,
    unit: { count: "只" },
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: "partial",
    warnings: payload.warnings,
  });
  return {
    id: `rs-membership-${envelope.payloadHash}`,
    source: envelope.source,
    asOf: "当前名单，与价格档案日期分别保存",
    text: JSON.stringify(payload),
    envelope,
  };
}
