import { createHash } from "node:crypto";
import type { Evidence } from "~/lib/domain";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { annualAmounts } from "./annual-cash-flow";
import {
  annualFinanceMetrics,
  queryFinance,
} from "../../data-sources/hithink/hithink-finance";
import { sharedRead } from "../../infra/shared-read";
import { get, put, sqlite } from "../../db";
import { background, updateJob } from "../../jobs/jobs";
import { isAStock } from "tstdx/local";

import { financialQualityFromAnnual } from "trading-strategies/research/value/financial-quality";

const fields = {
  revenue: "营业收入",
  operatingCost: "营业成本",
  netProfit: "净利润",
  parentProfit: ["归属于母公司所有者的净利润", "归母净利润"],
  minorityProfit: "少数股东损益",
  assets: ["资产总计", "总资产"],
  equity: ["所有者权益合计", "所有者权益"],
  currentAssets: ["流动资产合计", "流动资产"],
  currentLiabilities: ["流动负债合计", "流动负债"],
  operatingCashFlow: "经营活动产生的现金流量净额",
} as const;
/** Dimensionless observations on provider-declared yuan units, not certified valuation inputs. */
export function financialQuality(
  symbol: string,
  evidence: Evidence[],
  now = Date.now(),
) {
  const parsed = annualAmounts(symbol, evidence, fields, now);
  return financialQualityFromAnnual(symbol, parsed);
}
const shared = sharedRead<Awaited<ReturnType<typeof load>>>();
async function load(
  symbol: string,
  signal: AbortSignal,
  progress?: (done: number, total: number) => void,
) {
  const profiles = [
    "annual-cash-flow",
    ...Object.keys(annualFinanceMetrics),
  ] as ("annual-cash-flow" | keyof typeof annualFinanceMetrics)[];
  const evidence: Evidence[] = [],
    missingProfiles: string[] = [];
  // Two concurrent requests at most, with deterministic source ordering.
  for (let i = 0; i < profiles.length; i += 2) {
    signal.throwIfAborted();
    const batch = profiles.slice(i, i + 2);
    const outcomes = await Promise.allSettled(
      batch.map((profile) => queryFinance(symbol, signal, profile)),
    );
    signal.throwIfAborted();
    outcomes.forEach((outcome, index) =>
      outcome.status === "fulfilled"
        ? evidence.push(outcome.value)
        : missingProfiles.push(batch[index]!),
    );
    progress?.(Math.min(i + batch.length, profiles.length), profiles.length);
  }
  const facts = financialQuality(symbol, evidence);
  const hash = createHash("sha256")
    .update(JSON.stringify({ facts, evidence, missingProfiles }))
    .digest("hex");
  return {
    id: `financial-quality-${hash}`,
    hash,
    createdAt: Date.now(),
    facts,
    evidence,
    missingProfiles,
  };
}
export function gatherFinancialQuality(
  symbol: string,
  signal?: AbortSignal,
  progress?: (done: number, total: number) => void,
) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol))
    throw new Error(
      "财务质量档案当前仅支持A股公司，不适用于指数、ETF或其他品种",
    );
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  return shared(symbol, (abort) => load(symbol, abort, progress), signal);
}
export type FinancialQualityArchive = Awaited<ReturnType<typeof load>>;
export function financialQualityJob(symbol: string) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("财务质量档案当前仅支持A股公司");
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  return background(
    "research",
    { method: "financial-quality", symbol },
    async (job, signal) => {
      const archive = await gatherFinancialQuality(
        symbol,
        signal,
        (done, total) =>
          updateJob(job.id, {
            phase: `财务资料 ${done}/${total}`,
            progress: Math.round((done / total) * 90),
          }),
      );
      signal.throwIfAborted();
      if (!get(archive.id)) put("financial-quality", archive.id, archive);
      return { reportId: archive.id };
    },
    { method: "financial-quality", symbol },
  );
}
export function financialQualityHistory() {
  return sqlite()
    .prepare(
      `SELECT id, json_extract(payload,'$.createdAt') AS createdAt,
    json_extract(payload,'$.facts.symbol') AS symbol FROM records
    WHERE kind='financial-quality' ORDER BY updated_at DESC,id LIMIT 100`,
    )
    .all() as { id: string; createdAt: number; symbol: string }[];
}
