import { resolve } from "node:path";
import { z } from "zod";
import {
  auditUniverse,
  universeAuditQuerySchema,
  type UniverseAuditInput,
} from "~/lib/universe-audit";
import { historicalDateSchema } from "~/lib/historical-screen";
import { isRpsMarketSymbol } from "~/lib/rps";
import type { Coverage } from "~/lib/domain";
import { get, sqlite } from "../db";
import { settings } from "../infra/settings";
import { storedSecurityLifecycle } from "../market/security-lifecycle";
import { readTdxCodeChanges } from "../data-sources/tdx/tdx-code-changes";
import { readMarketPool } from "../market/market-pool-files";
import { fullDaySymbols } from "../data-sources/tdx/tdx-full-day-cache";
import { ResearchStore } from "../backtest/research-store";
import { RpsStore } from "../screening/rps-store";
import { latestRpsObservation } from "../screening/rps-observation";

const cachedLifecycleSchema = z
  .object({
    version: z.literal("security-lifecycle-2"),
    symbol: z.string(),
    source: z.string().min(1),
    fetchedAt: z
      .number()
      .finite()
      .refine((value) => Number.isFinite(new Date(value).getTime())),
    evidenceHash: z.string().min(1),
    listingDate: historicalDateSchema.nullable(),
    delistingDate: historicalDateSchema.nullable(),
  })
  .refine(
    (row) =>
      !row.listingDate ||
      !row.delistingDate ||
      row.listingDate <= row.delistingDate,
  );

/** Read-only projection: never refresh identity, capture a dataset, or scan prices. */
export async function universeAuditPage(input: unknown) {
  const query = universeAuditQuerySchema.parse(input);
  const config = settings();
  let root = config.tdxRoot;
  let symbols: string[];
  let source: string;
  let rosterAsOf: string | null = null;
  const coverage = new Map<string, { date: string | null; source: string }>();
  const warnings = [
    "退市统计按退市日 ≤ 区间终点，包含起点以前已退市的池内标的；不是全市场退市总数。",
    "代码映射仅覆盖 addedcode_bj.cfg 的北交所记录，记录日期不代表已核验的生效日期；沪深代码变更未知。",
    "无法枚举的是已被移除的证券；本地仍可能保留退市证券行情，不假定所有退市证券均已消失。",
    "上市/退市日期来自审计时既有缓存，不代表研究当时已知，缓存缺失或格式/版本不可信时不刷新。",
  ];
  if (query.source.kind === "research") {
    const store = new ResearchStore(sqlite());
    if (!store.isResultVisible(query.source.id))
      throw new Error("最终验证尚未揭示，不能读取冻结名单审计");
    const task = store.task(query.source.id),
      dataset = store.dataset(query.source.id);
    if (!task || !dataset) throw new Error("研究任务或冻结名单快照不存在");
    if (query.start !== task.spec.start || query.end !== task.spec.end)
      throw new Error("审计区间必须与原研究一致");
    root = dataset.root;
    symbols = dataset.membership.symbols;
    source = `研究冻结名单 ${dataset.hash} / ${dataset.membership.source?.name ?? "所选证券"}`;
    if (
      Number.isFinite(dataset.capturedAt) &&
      Number.isFinite(new Date(dataset.capturedAt).getTime())
    )
      rosterAsOf = new Date(dataset.capturedAt).toISOString();
    for (const stock of dataset.stocks) {
      const first = stock.bars.reduce<string | null>(
        (value, bar) => (value === null || bar.date < value ? bar.date : value),
        null,
      );
      coverage.set(stock.symbol, {
        date: first,
        source: `研究保存行情 ${stock.hash}（仅该快照覆盖，不是上市日）`,
      });
    }
    warnings.push(
      "名单时间为系统冻结研究快照时间，不是官方成分生效日；行情覆盖仅指保存的研究快照。",
    );
  } else if (query.source.kind === "concept") {
    const selected = query.source;
    const saved = new RpsStore(sqlite(), "concept").day(query.source.date);
    const observation = latestRpsObservation(root)?.groups.concept?.day;
    const day = [observation, saved].find(
      (day) =>
        day &&
        day.date === selected.date &&
        day.industry?.snapshot.hash === selected.hash,
    );
    if (!day?.industry)
      throw new Error("所选概念结果快照不可得，请刷新排名后重试");
    root = day.source.root;
    if (query.end !== day.date) throw new Error("概念审计终点必须为结果基准日");
    symbols = day.industry.snapshot.files
      .flatMap((file) => file.members)
      .filter(isRpsMarketSymbol);
    source = `概念结果成分并集 ${day.industry.snapshot.hash}`;
    warnings.push(
      "概念结果未存周期起点日期；此处为用户选择的审计区间，不宣称是所选 RPS 周期的收益窗口。",
    );
  } else if (query.source.pool) {
    const pool = await readMarketPool(
      config.industryBlocksRoot,
      query.source.pool,
      root,
      true,
    );
    symbols = pool.members.filter(isRpsMarketSymbol);
    source = `${pool.root}/${pool.file} SHA256:${pool.hash}`;
    warnings.push(
      "审计完整沪深成分名单，不随股票搜索或 RPS 阈值筛选缩小；读取时间不是名单快照时间。",
    );
  } else {
    const directory = get<{ root: string; entries: Record<string, unknown> }>(
      "security-directory",
    );
    if (!directory || resolve(directory.root) !== resolve(root))
      throw new Error(
        "当前数据源无既有证券主档，请先加载股票池；审计不会刷新主档",
      );
    const local = get<Coverage>("coverage");
    symbols = [
      ...Object.keys(directory.entries),
      ...(local && resolve(local.root) === resolve(root)
        ? local.securities
            .filter((row) => row.period === "day")
            .map((row) => row.symbol)
        : []),
      ...fullDaySymbols(),
    ].filter(isRpsMarketSymbol);
    source = `既有证券主档、覆盖与完整包索引 / ${root}`;
    warnings.push(
      "审计既有全部沪深名单，不随搜索或 RPS 阈值筛选缩小；不刷新证券主档。",
    );
  }
  if (query.source.kind !== "research")
    warnings.push(
      "既有证券主档与覆盖表未保存行情首日，覆盖未知；本次不扫描行情补齐，也不用名单或文件时间替代。",
    );
  const changes = await readTdxCodeChanges(root);
  if (changes.status === "unavailable")
    warnings.push(`代码变更证据不可用：${changes.error}`);
  const members = [...new Set(symbols)];
  const evidence: UniverseAuditInput["evidence"] = members.map((symbol) => {
    const saved = cachedLifecycleSchema.safeParse(
      storedSecurityLifecycle(symbol),
    );
    const lifecycle =
      saved.success && saved.data.symbol === symbol ? saved.data : null;
    return {
      symbol,
      listingDate: lifecycle?.listingDate ?? null,
      delistingDate: lifecycle?.delistingDate ?? null,
      lifecycleSource: lifecycle
        ? `${lifecycle.source} / 缓存时间 ${new Date(lifecycle.fetchedAt).toISOString()} / ${lifecycle.evidenceHash}`
        : "无可信既有上市/退市日期缓存（不外部核验）",
      localFirstDate: coverage.get(symbol)?.date ?? null,
      localSource:
        coverage.get(symbol)?.source ??
        "既有主档/覆盖表未记录行情首日，不扫描补齐",
      codeChanges: Object.entries(changes.changes)
        .filter(
          ([old, change]) =>
            old === symbol || `bj${change.targetCode}` === symbol,
        )
        .map(([old, change]) => ({
          date: change.recordedDate,
          source: `addedcode_bj.cfg ${changes.hash} / ${old} → bj${change.targetCode}（供应商记录日期）`,
        })),
    };
  });
  const { details, ...summary } = auditUniverse({
    symbols: members,
    source,
    start: query.start,
    end: query.end,
    rosterAsOf,
    rosterAsOfReason: "名单未记录可信快照时间；mtime 与本次读取时间均不采用",
    rosterIsCurrentSnapshot: true,
    evidence,
  });
  return {
    summary,
    warnings,
    metric: query.metric,
    total: details[query.metric].length,
    rows: details[query.metric].slice(query.page * 20, (query.page + 1) * 20),
  };
}
