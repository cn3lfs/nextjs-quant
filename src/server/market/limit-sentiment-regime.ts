import {
  evaluateSentimentRegime,
  selectDragonForwardCandidates,
} from "trading-strategies";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { z } from "zod";
import { beijingClock } from "~/lib/market/market-session";
import { readRecordSnapshot } from "../db";
import { readLimitObservations } from "../db/limit-sentiment-observations";
import { LIMIT_SENTIMENT_VERSION } from "./limit-sentiment";

const count = z.number().int().nonnegative();
const metric = z.number().finite().nullable();
const poolRow = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  price: z.number().finite(),
  changePct: metric,
  amount: metric,
  turnover: metric,
  industry: z.string(),
  streak: metric,
  breaks: metric,
  sealFund: metric,
});
const finalizedSnapshot = z.object({
  version: z.literal(LIMIT_SENTIMENT_VERSION),
  date: researchDateSchema,
  available: z.literal(true),
  final: z.literal(true),
  fetchedAt: z.number().int().nonnegative(),
  stats: z.object({
    limitUp: count,
    broken: count,
    limitDown: count,
    maxHeight: count,
    breakRate: z.number().min(0).max(100).nullable(),
    promotionRate: z.number().min(0).max(100).nullable(),
    yesterdayAvgChange: metric,
  }),
  pools: z.object({ zt: z.array(poolRow), yzt: z.array(poolRow) }),
});

export function sentimentRegimeSnapshot(options?: { asOfDate?: string }) {
  const now = Date.now();
  const asOf = researchDateSchema.parse(
    options?.asOfDate ?? beijingClock(now).date,
  );
  const completed = completedBarFilter("day", now);
  return readRecordSnapshot("limit-sentiment", (records) => {
    const snapshots: z.infer<typeof finalizedSnapshot>[] = [];
    for (const payload of records) {
      const result = finalizedSnapshot.safeParse(payload);
      if (
        result.success &&
        result.data.date <= asOf &&
        completed(result.data.date) &&
        result.data.fetchedAt <= now
      )
        snapshots.push(result.data);
    }
    snapshots.sort((a, b) => a.date.localeCompare(b.date));
    const history = snapshots.map(({ date, stats }) => ({ date, ...stats }));
    const latest = snapshots.at(-1);
    const current = latest?.date === asOf ? latest : undefined;
    const regime = evaluateSentimentRegime(current ? history : [], { asOf });
    const selection = selectDragonForwardCandidates({
      date: asOf,
      phase: regime.phase,
      ztPool: current?.pools.zt ?? [],
      yztPool: current?.pools.yzt ?? [],
    });
    const reason = current
      ? selection.reason
      : `${asOf} 缺少有效的收盘定稿四池快照，暂停新增候选。`;
    return {
      asOf,
      ...regime,
      forwardOnly: selection.forwardOnly,
      reason,
      stats: current ? (history.at(-1) ?? null) : null,
      candidates: selection.candidates,
      historyDays: history.length,
      disclosure: current
        ? `本机定稿四池回顾，共 ${history.length} 个已存交易日。当日有 ${readLimitObservations(asOf).length} 条本机盘中观测，仅作旁证。候选仅供前向观察，历史涨停排队成交未经证实。`
        : `${reason} 盘中观测不具备日线定稿资格。`,
    };
  });
}
