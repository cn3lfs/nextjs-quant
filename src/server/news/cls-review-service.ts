import { resolve } from "node:path";
import { settings } from "../infra/settings";
import { sqlite } from "../db";
import { monitorCalendar } from "../monitoring/monitor-calendar";
import { RpsStore } from "../screening/rps-store";
import { securityDirectory } from "../market/securities";
import { marketPoolCatalog, readMarketPool } from "../market/market-pool-files";
import { ClsReviewStore } from "./cls-review-store";
import { clsCandidates } from "./cls-candidates";
import { buildClsSample } from "./cls-sample";
import {
  completedRpsObservation,
  observationRanking,
} from "../screening/rps-observation";

export async function fixClsSample(reportId: string) {
  const store = new ClsReviewStore(sqlite());
  const report = store.report(reportId);
  if (!report) throw new Error("报告不存在");
  if (report.batch && report.batch.phase !== "morning")
    throw new Error("增量报告不能替换盘前主样本");
  const startedAt = Date.now();
  const date = new Date(startedAt + 8 * 3600000).toISOString().slice(0, 10);
  const existing = store.sample(date);
  if (existing) return existing;
  if (startedAt >= Date.parse(`${date}T09:30:00+08:00`))
    throw new Error("已开盘，不能补选盘前样本");
  const config = settings();
  const calendar = await monitorCalendar(
    config.tdxRoot,
    config.calendar,
    false,
    true,
    startedAt,
  );
  const previousTradingDay = calendar.days.filter((day) => day < date).at(-1);
  if (!calendar.days.includes(date) || !previousTradingDay)
    throw new Error("尚不能确认当日交易日历");
  const rps = new RpsStore(sqlite());
  const observation = completedRpsObservation(
    config.tdxRoot,
    previousTradingDay,
    "close",
  );
  const day = observation?.day ?? rps.day(previousTradingDay);
  const directory = await securityDirectory();
  const validRps = day && resolve(day.source.root) === resolve(config.tdxRoot);
  const candidateDependencies = {
    securities: Object.values(directory.entries),
    pool: (category: "industry" | "concept", name: string) =>
      readMarketPool(
        config.industryBlocksRoot,
        { category, name },
        config.tdxRoot,
      ),
    ranking: validRps
      ? observation
        ? observationRanking(observation, 50)
        : rps.ranking(previousTradingDay, 50)
      : [],
    rpsDate: previousTradingDay,
    rpsHash: validRps ? day.inputHash : "not-used-explicit-recommendation",
  };
  let candidates = await clsCandidates(report.report, {
    ...candidateDependencies,
    pools: [],
  });
  if (
    !candidates.candidates.some(
      (candidate) => candidate.basis === "explicit-recommendation",
    )
  ) {
    if (!validRps)
      throw new Error("缺少当前目录上一交易日RPS，无法固定板块候选");
    const pools: { category: "industry" | "concept"; name: string }[] = [];
    for (const category of ["industry", "concept"] as const) {
      const catalog = await marketPoolCatalog(
        config.industryBlocksRoot,
        category,
        config.tdxRoot,
      );
      pools.push(...catalog.names.map((name) => ({ category, name })));
    }
    candidates = await clsCandidates(report.report, {
      ...candidateDependencies,
      pools,
    });
  }
  const sample = buildClsSample({
    report,
    now: Date.now(),
    date,
    previousTradingDay,
    calendarSource: calendar.source,
    isTradingDay: true,
    poolHash: candidates.poolHash,
    candidates: candidates.candidates,
  });
  if (!sample.selected && candidates.unmatched.length)
    sample.reason = candidates.unmatched.map((item) => item.reason).join("；");
  return store.saveSample(sample);
}
