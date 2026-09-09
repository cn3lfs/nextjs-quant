import { createHash } from "node:crypto";
import { z } from "zod";
import type { Snapshot, Evidence } from "~/lib/domain";
import { request } from "./hithink-context";
import { sharedRead } from "./shared-read";
import { canslimSectorRank } from "./canslim-sector-rank";
import { evidenceEnvelope } from "./evidence";
const shared = sharedRead<unknown>();
const basicSchema = z.object({
  status_code: z.literal(0),
  datas: z
    .array(
      z.object({ 股票代码: z.string(), 所属同花顺二级行业: z.string().min(1) }),
    )
    .length(1),
});
export function sectorMembershipAudit(
  raw: unknown,
  prices: unknown,
  industry: string,
) {
  const schema = z.object({
    status_code: z.literal(0),
    code_count: z.number().int().positive(),
    datas: z.array(
      z.object({
        股票代码: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/),
        所属同花顺二级行业: z.literal(industry),
      }),
    ),
  });
  const data = schema.parse(raw),
    price = schema.parse(prices);
  const codes = (value: typeof data) => {
    const result = value.datas.map((row) => row.股票代码).sort();
    if (
      result.length !== value.code_count ||
      new Set(result).size !== result.length
    )
      throw new Error("行业成分名单不完整或重复");
    return result;
  };
  const all = codes(data),
    priced = codes(price);
  const allSet = new Set(all),
    priceSet = new Set(priced);
  return {
    membershipCount: all.length,
    priceCount: priced.length,
    missingFromPrices: all.filter((code) => !priceSet.has(code)),
    extraInPrices: priced.filter((code) => !allSet.has(code)),
    warning: "同来源独立当前名单对照，不证明历史成分范围或企业行动可比性。",
  };
}
function window(snapshot: Snapshot) {
  if (
    [snapshot.bars.at(-61)?.close, snapshot.bars.at(-1)?.close].some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value <= 0,
    )
  )
    throw new Error("行业排名快照端点非法");
  if (
    snapshot.period !== "day" ||
    snapshot.historicalAsOf ||
    snapshot.bars.length < 61
  )
    throw new Error("行业排名需要当前至少61条日线");
  return {
    start: snapshot.bars.at(-61)!.date,
    end: snapshot.bars.at(-1)!.date,
    code: `${snapshot.symbol.slice(2)}.${snapshot.symbol.slice(0, 2).toUpperCase()}`,
  };
}
export function sectorRankEvidence(
  snapshot: Snapshot,
  basic: unknown,
  sectors: unknown,
  members: unknown,
  sectorCode: string,
  fetchedAt: number,
  membership: unknown = null,
): Evidence {
  const { start, end, code } = window(snapshot);
  const identity = basicSchema.parse(basic).datas[0]!;
  if (identity.股票代码 !== code) throw new Error("行业归属证券不匹配");
  const candidates = z
    .object({
      datas: z.array(z.object({ 指数代码: z.string(), 指数简称: z.string() })),
    })
    .parse(sectors).datas;
  const matching = candidates.filter(
    (c) => c.指数简称 === identity.所属同花顺二级行业,
  );
  if (matching.length !== 1 || matching[0]!.指数代码 !== sectorCode)
    throw new Error("行业归属与指数不匹配");
  const diagnostic = canslimSectorRank(
    sectors,
    members,
    code,
    sectorCode,
    end,
    start,
  );
  const endpoints = diagnostic.stockReturn.endpoints;
  if (
    !endpoints ||
    Math.abs(Number(endpoints.start) - snapshot.bars.at(-61)!.close) >= 0.005 ||
    Math.abs(Number(endpoints.end) - snapshot.bars.at(-1)!.close) >= 0.005
  )
    throw new Error("行业排名个股端点与快照不一致");
  const membershipAudit =
    membership === null
      ? null
      : sectorMembershipAudit(membership, members, identity.所属同花顺二级行业);
  if (!membershipAudit)
    diagnostic.warnings.push(
      "独立行业成分名单未取得，价格列表覆盖范围尚未对照。",
    );
  else if (
    membershipAudit.missingFromPrices.length ||
    membershipAudit.extraInPrices.length
  )
    diagnostic.warnings.push(
      `独立行业成分名单与价格列表不一致：缺失${membershipAudit.missingFromPrices.length}只、额外${membershipAudit.extraInPrices.length}只；排名仅为价格列表观察。`,
    );
  const payload = {
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    basic,
    sectors,
    members,
    membership,
    membershipAudit,
    sectorCode,
    diagnostic,
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink/sector-rank",
    symbol: snapshot.symbol,
    type: "quote-financial",
    asOf: end,
    publishedAt: null,
    fetchedAt,
    currency: "CNY",
    unit: { stockPrice: "元", indexPrice: "点", return: "%" },
    adjustment: "none",
    reportPeriod: null,
    quality: "partial",
    warnings: diagnostic.warnings,
  });
  return {
    id: `sector-rank-${envelope.payloadHash}`,
    source: envelope.source,
    asOf: end,
    envelope,
    text: JSON.stringify(payload),
  };
}
export function sectorRankFromEvidence(snapshot: Snapshot, evidence: Evidence) {
  if (
    evidence.envelope?.source !== "hithink/sector-rank" ||
    evidence.envelope.symbol !== snapshot.symbol ||
    evidence.envelope.payloadHash !==
      createHash("sha256").update(evidence.text).digest("hex")
  )
    throw new Error("行业排名证据身份或指纹不一致");
  const payload = z
    .object({
      snapshotId: z.literal(snapshot.id),
      snapshotHash: z.literal(snapshot.hash),
      basic: z.unknown(),
      sectors: z.unknown(),
      members: z.unknown(),
      sectorCode: z.string(),
      membership: z.unknown().optional(),
    })
    .parse(JSON.parse(evidence.text));
  const checked = sectorRankEvidence(
    snapshot,
    payload.basic,
    payload.sectors,
    payload.members,
    payload.sectorCode,
    evidence.envelope.fetchedAt,
    payload.membership ?? null,
  );
  return (
    JSON.parse(checked.text) as {
      diagnostic: ReturnType<typeof canslimSectorRank>;
    }
  ).diagnostic;
}
export async function querySectorRank(
  snapshot: Snapshot,
  signal?: AbortSignal,
) {
  const { start, end, code } = window(snapshot);
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  signal?.throwIfAborted();
  const basic = await shared(
    `industry:${code}`,
    (upstream) =>
      request(
        "hithink-basicinfo-query",
        `${code} 所属同花顺二级行业`,
        upstream,
      ),
    signal,
  );
  const identity = basicSchema.parse(basic).datas[0]!;
  if (
    identity.股票代码 !== code ||
    !/^[\u4e00-\u9fffA-Za-z0-9（）()ⅢⅡⅠ&及、 -]{1,60}$/.test(
      identity.所属同花顺二级行业,
    )
  )
    throw new Error("行业归属无法核验");
  const query = `${start.replaceAll("-", "")}不复权收盘价 ${end.replaceAll("-", "")}不复权收盘价`;
  const [sectors, members, membership] = await Promise.all([
    shared(
      `sectors:${query}`,
      (upstream) =>
        request(
          "hithink-sector-selector",
          `同花顺二级行业指数 ${query}`,
          upstream,
          1,
          1000,
        ),
      signal,
    ),
    shared(
      `members:${identity.所属同花顺二级行业}:${query}`,
      (upstream) =>
        request(
          "hithink-astock-selector",
          `所属同花顺二级行业为${identity.所属同花顺二级行业} ${query} 股票代码`,
          upstream,
          1,
          10000,
        ),
      signal,
    ),
    shared(
      `member-list:${identity.所属同花顺二级行业}`,
      (upstream) =>
        request(
          "hithink-astock-selector",
          `所属同花顺二级行业为${identity.所属同花顺二级行业} 股票代码`,
          upstream,
          1,
          10000,
        ),
      signal,
    ).catch(() => {
      signal?.throwIfAborted();
      return null;
    }),
  ]);
  signal?.throwIfAborted();
  const rows = z
    .object({
      datas: z.array(z.object({ 指数简称: z.string(), 指数代码: z.string() })),
    })
    .parse(sectors).datas;
  const target = rows.filter((r) => r.指数简称 === identity.所属同花顺二级行业);
  if (target.length !== 1) throw new Error("行业指数身份不唯一");
  return sectorRankEvidence(
    snapshot,
    basic,
    sectors,
    members,
    target[0]!.指数代码,
    Date.now(),
    membership,
  );
}
