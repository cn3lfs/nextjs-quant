import {
  aggregateIndustryRps,
  type IndustrySnapshot,
} from "~/lib/industry-rps";
import { readRpsBlockSource } from "./rps-block-source";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Bar } from "~/lib/domain";
import {
  rpsPeriods,
  rpsPolicy,
  type RpsDay,
  type RpsProgress,
  type RpsRequest,
} from "~/lib/rps";
import { historicalDateSchema } from "~/lib/historical-screen";
import { parseBars, scan } from "./tdx";
import { readLocalDailySnapshot } from "./local-daily-snapshot";
import { readGbbq } from "./tdx-gbbq";
import type { TdxXdxr } from "./tdx-wire";
import {
  calculateRpsDay,
  prepareRpsSecurity,
  rpsHash,
  type RpsSecurity,
} from "./rps-engine";
import { RpsStore } from "./rps-store";
import { overlayDailyIncrements } from "./tdx-daily-overlay";
import { readDailyIncrementRange } from "./tdx-daily-cache";
import { fullDaySymbols, readFullDaySnapshot } from "./tdx-full-day-cache";
import { isRpsMarketSymbol } from "~/lib/rps";

export type RpsDependencies = {
  incrementSnapshots?: () => string[];
  industries?: (checkpoint: () => void) => Promise<IndustrySnapshot>;
  root: string;
  calendar: () => Promise<{ days: string[]; source: string }>;
  universe: () => Promise<{ symbol: string; name: string }[]>;
  bars: (symbol: string) => Promise<Bar[]>;
  actions: () => Promise<{ events: Map<string, TdxXdxr[]>; source: string }>;
};
export function localRpsDependencies(
  root: string,
  overrides: string[],
  blocksRoot = "",
  category: "industry" | "concept" = "industry",
  source: "blocks" | "tdx" = "blocks",
): RpsDependencies {
  const versions = new Set<string>();
  const today = () =>
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return {
    incrementSnapshots: () => [...versions].sort(),
    industries: (checkpoint) =>
      readRpsBlockSource(
        { source, blocksRoot, tdxRoot: root },
        category,
        checkpoint,
      ),
    root: resolve(root),
    calendar: async () => {
      if (overrides.length)
        return {
          days: overrides.map((d) => historicalDateSchema.parse(d)),
          source: "用户确认的交易日期",
        };
      // 750 retained days plus 250 warmup sessions. Older index records can contain
      // invalid prices; they are outside this product's date horizon, not silently repaired.
      const path = join(root, "vipdoc/sh/lday/sh000001.day");
      let days: string[] = [];
      let localFailure: unknown;
      try {
        const before = await stat(path),
          bytes = await readFile(path),
          after = await stat(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new Error("RPS参考日历正在更新");
        if (bytes.length % 32) throw new Error("RPS参考日历记录不完整");
        days = parseBars(
          bytes.subarray(Math.max(0, bytes.length - 1000 * 32)),
          "day",
        ).map((b) => b.date);
      } catch (error) {
        localFailure = error;
      }
      const cached = readFullDaySnapshot("sh000001");
      let usedFull = false;
      if (cached && (!days.length || cached.bars.at(-1)!.date > days.at(-1)!)) {
        days = cached.bars.slice(-1000).map((bar) => bar.date);
        for (const version of cached.sourceVersions ?? [])
          versions.add(version);
        usedFull = true;
      }
      if (!days.length && localFailure) throw localFailure;
      const increments = days.length
        ? readDailyIncrementRange("sh000001", days[0]!, today())
        : [];
      for (const item of increments) versions.add(item.snapshot.id);
      return {
        days: [
          ...new Set([
            ...days,
            ...increments.map((item) => item.record.bar.date),
          ]),
        ].sort(),
        source:
          `${usedFull ? "完整包缓存" : "本地"}上证指数最近1000根已有交易日期（非完整官方日历）` +
          (increments.length ? "，含通达信已发布日线增量" : ""),
      };
    },
    universe: async () => {
      const imported = fullDaySymbols().filter(isRpsMarketSymbol);
      const local = await scan(root).catch((error: unknown) => {
        if (!imported.length) throw error;
        return { securities: [] };
      });
      const rows = local.securities
        .filter((s) => s.period === "day")
        .map(({ symbol, name }) => ({ symbol, name }));
      const existing = new Set(rows.map((row) => row.symbol));
      return [
        ...rows,
        ...imported
          .filter((symbol) => !existing.has(symbol))
          .map((symbol) => ({ symbol, name: symbol })),
      ];
    },
    bars: async (symbol) => {
      const snapshot = overlayDailyIncrements(
        await readLocalDailySnapshot(root, symbol),
        today(),
      );
      for (const version of snapshot.sourceVersions ?? [])
        versions.add(version);
      return snapshot.bars;
    },
    actions: async () => {
      const value = await readGbbq(root);
      return { events: value.events, source: value.path };
    },
  };
}

export async function runRpsJob(
  store: RpsStore,
  deps: RpsDependencies,
  request: RpsRequest,
  progress: RpsProgress,
  now: number,
  report: (value: RpsProgress) => void = () => {},
  cancelled: () => boolean = () => false,
) {
  const checkpoint = (phase: string) => {
    if (cancelled()) throw new Error("rps-cancelled");
    progress.phase = phase;
    store.checkpoint(progress);
    report({ ...progress });
  };
  try {
    if (store.target !== (request.target ?? "stock"))
      throw new Error("RPS请求与存储类型不匹配");
    checkpoint("读取参考日历与预热日期");
    const local = new Date(now + 8 * 3600000).toISOString(),
      today = local.slice(0, 10);
    const calendar = await deps.calendar();
    const days = calendar.days.filter(
      (d) => d < today || (d === today && local.slice(11, 16) >= "15:05"),
    );
    if (
      days.some(
        (d, i) =>
          !historicalDateSchema.safeParse(d).success ||
          (i > 0 && d <= days[i - 1]!),
      )
    )
      throw new Error("RPS交易日历无效、重复或倒序");
    if (request.mode === "forward" && days.at(-1) !== today)
      throw new Error("向前RPS仅接受今天15:05后且参考日历已确认的交易日");
    const targets =
      request.mode === "forward" ? [today] : days.slice(-request.days);
    if (!targets.length || days.indexOf(targets[0]!) < Math.max(...rpsPeriods))
      throw new Error("RPS日历不足：回填前需要250个参考交易日");
    const pending = targets.filter((d) => !store.day(d));
    progress.totalDays = pending.length;
    if (pending.length) {
      const industrySnapshot =
        request.target === "industry" || request.target === "concept"
          ? await deps.industries?.(() =>
              checkpoint(
                request.target === "concept"
                  ? "读取概念成分快照"
                  : "读取申万行业成分快照",
              ),
            )
          : undefined;
      if (
        (request.target === "industry" || request.target === "concept") &&
        !industrySnapshot
      )
        throw new Error(
          request.target === "concept"
            ? "缺少概念成分数据源"
            : "缺少申万行业成分数据源",
        );
      if (
        industrySnapshot &&
        (industrySnapshot.category ?? "industry") !== request.target
      )
        throw new Error("板块成分分类与任务不匹配");
      if (industrySnapshot) {
        const absent = store
          .latest()
          ?.industry?.snapshot.files.filter(
            (f) => !industrySnapshot.files.some((n) => n.file === f.file),
          );
        if (absent?.length)
          throw new Error(
            `行业名单文件缺失（相对最近结果）：${absent.map((f) => f.file).join("、")}`,
          );
      }
      checkpoint("读取证券池与GBBQ");
      const universe = (await deps.universe()).sort((a, b) =>
        a.symbol.localeCompare(b.symbol),
      );
      if (
        !universe.length ||
        universe.length > rpsPolicy.maxSymbols ||
        new Set(universe.map((s) => s.symbol)).size !== universe.length
      )
        throw new Error("RPS本地证券池为空、重复或超过10000只上限");
      const actions = await deps.actions();
      const actionEntries = [...actions.events].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const coverage = actionEntries
        .flatMap(([, events]) => events.map((e) => e.date))
        .sort()
        .at(-1);
      if (!coverage || coverage < pending.at(-1)!)
        throw new Error("GBBQ事件覆盖不足；禁止降级为不复权RPS");
      const source: RpsDay["source"] = {
        root: deps.root,
        calendar: calendar.source,
        calendarHash: rpsHash(days),
        actionsHash: rpsHash({ source: actions.source, events: actionEntries }),
        actionsCoverage: coverage,
        universeHash: rpsHash(universe),
      };
      progress.total = universe.length;
      const stocks: RpsSecurity[] = [];
      const keepFrom =
        days[days.indexOf(pending[0]!) - Math.max(...rpsPeriods)]!;
      for (const stock of universe) {
        checkpoint(`读取后复权行情 ${stock.symbol}`);
        // Failure is fatal: silently dropping unreadable stocks would change every rank.
        const bars = (await deps.bars(stock.symbol)).filter(
          (b) => b.date <= pending.at(-1)!,
        );
        stocks.push(
          prepareRpsSecurity(
            stock.symbol,
            stock.name,
            bars,
            actions.events.get(stock.symbol) ?? [],
            keepFrom,
          ),
        );
        progress.scanned++;
      }
      source.incrementSnapshots = deps.incrementSnapshots?.();
      for (const date of pending) {
        checkpoint(`计算并固定 ${date}`);
        const stockResult = calculateRpsDay(stocks, days, date);
        const industryResult = industrySnapshot
          ? aggregateIndustryRps(industrySnapshot, stockResult)
          : undefined;
        const result = industryResult
          ? {
              ...stockResult,
              ...industryResult,
              inputHash: rpsHash({
                stock: stockResult.inputHash,
                snapshot: industrySnapshot!.hash,
                rows: industryResult.rows,
              }),
            }
          : stockResult;
        if (!industryResult && !result.counts.some((n) => n > 0))
          throw new Error(`${date}没有可计算的RPS，未发布空排名`);
        store.saveDay(
          {
            industry: industryResult?.industry,
            date,
            mode: request.mode,
            periods: [...rpsPeriods],
            policy: rpsPolicy,
            total: industrySnapshot?.files.length ?? universe.length,
            pool: result.pool,
            counts: result.counts,
            excluded: result.excluded,
            missing: result.missing,
            inputHash: result.inputHash,
            source,
            createdAt: now,
          },
          result.rows,
          () => checkpoint(`提交 ${date}`),
        );
        progress.completedDays++;
      }
    }
    checkpoint("完成");
    progress.status = "complete";
  } catch (error) {
    progress.error = error instanceof Error ? error.message : "RPS任务失败";
    progress.status =
      progress.error === "rps-cancelled" ? "cancelled" : "failed";
  }
  progress.updatedAt = Date.now();
  store.finish(progress);
  report({ ...progress });
  return progress;
}
