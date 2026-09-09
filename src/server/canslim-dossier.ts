import { createHash } from "node:crypto";
import { querySectorRank, sectorRankFromEvidence } from "./hithink-sector-rank";
import { queryFloat, floatFromEvidence } from "./hithink-float";
import { queryRsMembershipEvidence } from "./rs-membership";
import { queryPriceRsEvidence } from "./price-rs";
import { canslimRs } from "./canslim-rs";
import { queryInstitutions } from "./hithink-institutions";
import { canslimInstitutions } from "./canslim-institutions";
import type { Evidence, Snapshot } from "~/lib/domain";
import {
  gatherCanslimFinance,
  mergeCanslimFinance,
} from "./canslim-finance-bundle";
import { gatherCanslimMarket } from "./canslim-market-data";
import { canslimMarket } from "./canslim-market";
import { canslimTechnical } from "./canslim-technical";
import { canslimScorecard, type CanslimScoreInput } from "./canslim-scorecard";
import { evidenceEnvelope } from "./evidence";

type Market = Awaited<ReturnType<typeof gatherCanslimMarket>>;
export function buildCanslimDossier(
  snapshot: Snapshot,
  financeEvidence: Evidence[],
  market: Market | null,
  now = Date.now(),
  institutions: Evidence | null = null,
  rsEvidence: Evidence | null = null,
  rsMembership: Evidence | null = null,
  floatEvidence: Evidence | null = null,
  sectorEvidence: Evidence | null = null,
) {
  if (snapshot.historicalAsOf)
    throw new Error("当前CANSLIM资料包尚不支持历史时点研究");
  const finance = mergeCanslimFinance(snapshot.symbol, financeEvidence);
  const technical = canslimTechnical(snapshot, now, market?.snapshot ?? null);
  const payload = {
    snapshotHash: snapshot.hash,
    symbol: snapshot.symbol,
    technical,
  };
  const envelope = evidenceEnvelope(payload, {
    source: snapshot.source,
    symbol: snapshot.symbol,
    type: "bars",
    asOf: snapshot.bars.at(-1)?.date ?? null,
    publishedAt: null,
    fetchedAt: snapshot.createdAt,
    currency: "CNY",
    unit: { price: "元", volume: "源单位见快照" },
    adjustment: snapshot.adjustment,
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "技术诊断基于所附快照版本，未核验交易日缺口、企业行动与当前源时效。",
    ],
  });
  const stockEvidence: Evidence = {
    id: `canslim-technical-${envelope.payloadHash}`,
    source: snapshot.source,
    asOf: envelope.asOf ?? "未知",
    envelope,
    text: JSON.stringify(payload),
  };
  const evidence = [...financeEvidence, stockEvidence];
  const inputs: CanslimScoreInput[] = finance.earnings.checks.map((check) => ({
    ...check,
    evidenceIds: [
      ...new Set(check.fields.flatMap((field) => finance.origins[field] ?? [])),
    ],
  }));
  for (const check of [technical.newHigh, technical.volume])
    inputs.push({
      id: check.id,
      maxPoints: check.maxPoints,
      points: check.points,
      status: check.status as CanslimScoreInput["status"],
      evidenceIds: [stockEvidence.id],
      reason: check.warnings.join("\n"),
    });
  const aligned =
    market !== null &&
    market.snapshot.symbol === "sh000300" &&
    market.snapshot.bars.at(-1)?.date === snapshot.bars.at(-1)?.date;
  if (market) {
    const marketPayload = {
      snapshotHash: market.snapshot.hash,
      scriptHash: market.scriptHash,
      diagnostic: canslimMarket(market.snapshot, now),
    };
    const marketEnvelope = evidenceEnvelope(marketPayload, {
      ...market.envelope,
      source: "tencent/westock-data",
      symbol: "sh000300",
    });
    const item: Evidence = {
      id: `canslim-market-${marketEnvelope.payloadHash}`,
      source: marketEnvelope.source,
      asOf: marketEnvelope.asOf ?? "未知",
      envelope: marketEnvelope,
      text: JSON.stringify(marketPayload),
    };
    evidence.push(item);
    for (const check of marketPayload.diagnostic.checks)
      inputs.push({
        id: check.id,
        maxPoints: check.maxPoints,
        points: aligned ? check.points : 0,
        status: aligned
          ? (check.status as CanslimScoreInput["status"])
          : "missing",
        evidenceIds: [item.id],
        reason: aligned
          ? "市场计算诊断；口径与缺口见引用证据"
          : "指数与个股最后日线日期不一致，不混合评分",
      });
  }
  if (institutions) {
    if (
      institutions.envelope?.symbol !== snapshot.symbol ||
      institutions.envelope.source !== "hithink-management-query"
    )
      throw new Error("机构证据身份不匹配");
    const payload = JSON.parse(institutions.text) as { response: unknown };
    const check = canslimInstitutions(snapshot.symbol, payload.response);
    evidence.push(institutions);
    inputs.push({
      id: check.id,
      maxPoints: check.maxPoints,
      points: check.points,
      status: check.status as CanslimScoreInput["status"],
      evidenceIds: [institutions.id],
      reason: check.warnings.join("\n"),
    });
  }
  const relativeStrength = rsEvidence ? canslimRs(snapshot, rsEvidence) : null;
  if (rsEvidence && relativeStrength) {
    evidence.push(rsEvidence);
    inputs.push(relativeStrength);
  }
  if (rsMembership) evidence.push(rsMembership);
  const float = floatEvidence
    ? floatFromEvidence(
        snapshot.symbol,
        snapshot.bars.at(-1)?.date ?? "",
        floatEvidence,
      )
    : null;
  if (floatEvidence && float) {
    evidence.push(floatEvidence);
    inputs.push({
      id: float.id,
      maxPoints: float.maxPoints,
      points: float.points,
      status: float.status as CanslimScoreInput["status"],
      evidenceIds: [floatEvidence.id],
      reason: float.warnings.join("\n"),
    });
  }
  const sectorRank = sectorEvidence
    ? sectorRankFromEvidence(snapshot, sectorEvidence)
    : null;
  if (sectorEvidence && sectorRank) {
    evidence.push(sectorEvidence);
    inputs.push({
      id: "L2",
      maxPoints: 6,
      points: 0,
      status: "missing",
      evidenceIds: [sectorEvidence.id],
      reason: sectorRank.warnings.join("\n"),
    });
  }
  const scorecard = canslimScorecard(
    inputs,
    evidence.map((item) => item.id),
  );
  const id =
    "canslim-dossier-" +
    createHash("sha256")
      .update(JSON.stringify({ scorecard, evidence }))
      .digest("hex");
  return {
    id,
    version: "canslim-dossier-7",
    symbol: snapshot.symbol,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    evidence,
    scorecard,
    finance,
    technical,
    relativeStrength,
    float,
    sectorRank,
    marketAligned: aligned,
    warnings: [
      "当前研究资料包，尚非完整六阶段报告；缺失项不会补为通过。",
      "财务披露时点与股本可比性未独立核验，不可用于历史信号或账户交易。",
    ],
  };
}
export async function gatherCanslimDossier(
  snapshot: Snapshot,
  signal?: AbortSignal,
) {
  if (snapshot.historicalAsOf)
    throw new Error("当前CANSLIM资料包尚不支持历史时点研究");
  signal?.throwIfAborted();
  const now = Date.now();
  const [finance, market, institutions, rs, float, sector] =
    await Promise.allSettled([
      gatherCanslimFinance(snapshot.symbol, signal),
      gatherCanslimMarket(now, signal),
      queryInstitutions(snapshot.symbol, signal),
      queryPriceRsEvidence(snapshot, signal),
      Promise.resolve().then(() =>
        queryFloat(snapshot.symbol, snapshot.bars.at(-1)?.date ?? "", signal),
      ),
      querySectorRank(snapshot, signal),
    ]);
  signal?.throwIfAborted();
  let membership: Evidence | null = null;
  if (rs.status === "fulfilled") {
    try {
      membership = await queryRsMembershipEvidence(rs.value, signal);
    } catch {
      signal?.throwIfAborted();
    }
  }
  return {
    ...buildCanslimDossier(
      snapshot,
      finance.status === "fulfilled" ? finance.value.evidence : [],
      market.status === "fulfilled" ? market.value : null,
      now,
      institutions.status === "fulfilled" ? institutions.value : null,
      rs.status === "fulfilled" ? rs.value : null,
      membership,
      float.status === "fulfilled" ? float.value : null,
      sector.status === "fulfilled" ? sector.value : null,
    ),
    sourceFailures: [
      ...(finance.status === "fulfilled" ? finance.value.missing : ["finance"]),
      ...(market.status === "rejected" ? ["market"] : []),
      ...(institutions.status === "rejected" ? ["institutions"] : []),
      ...(rs.status === "rejected" ? ["relative-strength"] : []),
      ...(!membership ? ["rs-membership"] : []),
      ...(float.status === "rejected" ? ["float"] : []),
      ...(sector.status === "rejected" ? ["sector-rank"] : []),
    ],
  };
}
