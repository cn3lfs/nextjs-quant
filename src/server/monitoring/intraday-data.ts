import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { IntradayConfig } from "~/lib/strategy-facts/intraday-schedule";
import type { Bar } from "~/lib/domain";
import { isRpsMarketSymbol } from "~/lib/screening/rps";
import { settings } from "../infra/settings";
import { sqlite } from "../db";
import { RpsStore } from "../screening/rps-store";
import { readMarketPool } from "../market/market-pool-files";
import { readSnapshot } from "../data-sources/tdx/tdx";
import { barPage } from "../data-sources/tdx/tdx-quotes";
import {
  latestRpsObservation,
  observationRanking,
} from "../screening/rps-observation";
// g4day 暂停：import { overlayDailyIncrements } from "./tdx-daily-overlay";
import { readLocalDailySnapshot } from "../market/local-daily-snapshot";

export async function intradayPool(
  config: IntradayConfig,
  previousTradingDay: string,
  availableAt = Date.now(),
) {
  const app = settings();
  const store = new RpsStore(sqlite());
  const observation = latestRpsObservation(app.tdxRoot, availableAt);
  const day = observation?.day ?? store.day(previousTradingDay);
  if (!day || resolve(day.source.root) !== resolve(app.tdxRoot))
    throw new Error("缺少当前数据目录上一交易日的RPS，请先计算");
  const pool = config.pool
    ? await readMarketPool(app.industryBlocksRoot, config.pool, app.tdxRoot)
    : null;
  const ranking = observation
    ? observationRanking(observation, config.rpsPeriod)
    : store.ranking(previousTradingDay, config.rpsPeriod);
  const members = pool?.members ?? ranking.map((row) => row.symbol);
  const memberSet = new Set(members);
  const rows = ranking
    .filter(
      (row) =>
        memberSet.has(row.symbol) &&
        isRpsMarketSymbol(row.symbol) &&
        row.rps >= config.minimumRps,
    )
    .sort((a, b) => b.rps - a.rps || a.symbol.localeCompare(b.symbol));
  return {
    rows,
    members,
    source: pool,
    rpsDay: day,
    hash: createHash("sha256")
      .update(
        JSON.stringify({
          members,
          pool: pool?.hash ?? null,
          rps: day.inputHash,
          period: config.rpsPeriod,
          minimum: config.minimumRps,
        }),
      )
      .digest("hex"),
  };
}

/** Fetch complete available daily history, failing at a guard rather than
 * silently changing recursive indicator seeds by truncating the series.
 */
async function onlineDaily(symbol: string): Promise<Bar[]> {
  let bars: Bar[] = [];
  for (let start = 0; start < 20000; start += 800) {
    const page = await barPage(symbol, "day", start, 800);
    if (page.length && bars.length && page.at(-1)!.date >= bars[0]!.date)
      throw new Error("在线日线分页重叠或顺序异常");
    bars = [...page, ...bars];
    if (page.length < 800) return bars;
  }
  throw new Error("在线日线历史超过读取上限，未截断计算");
}

export async function intradayHistory(
  source: IntradayConfig["source"],
  symbol: string,
) {
  if (!isRpsMarketSymbol(symbol)) throw new Error("预选仅支持沪深A股");
  if (source === "tdx-local") {
    const root = settings().tdxRoot;
    const [daily, minutes] = await Promise.all([
      readLocalDailySnapshot(root, symbol),
      readSnapshot(root, symbol, "5m"),
    ]);
    // g4day 暂停（见 docs/decisions.md WF3）：只读本地日线，不叠加通达信增量。
    const merged = daily;
    return {
      daily: merged.bars,
      sourceVersions: merged.sourceVersions,
      minutes: minutes.bars,
      fetchedAt: Math.max(daily.createdAt, minutes.createdAt),
    };
  }
  const daily = await onlineDaily(symbol);
  const minutes = await barPage(symbol, "5m", 0, 800);
  return { daily, minutes, fetchedAt: Date.now() };
}
