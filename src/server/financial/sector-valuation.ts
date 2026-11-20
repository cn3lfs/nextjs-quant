import { readTdxLocalBlocks, resolveTdxRoot } from "tstdx/local";
import { financialDate } from "trading-strategy-core/financial";
import {
  beijingCalendarDate,
  sectorValuationInput,
  type SectorValuationCategory,
  type SectorValuationMetric,
  type SectorValuationResult,
  type SectorValuationRow,
  type SectorValuationSort,
  type SectorValuationWindow,
} from "~/lib/financial/sector-valuation";
import { readLocalFinancialSeries } from "../data-sources/tdx/local-financial-files";
import { PrioritySlots } from "../infra/priority-slots";

/**
 * 板块估值分位只使用通达信本地板块序列：
 * - BK5 首列 PE-TTM 整体法，BK6 首列 PB-MRQ 整体法；
 * - 两值按同一个不晚于北京时间截止日的最新记录日对齐，单值缺失不借用前一日；
 * - 同组同日重复按歧义缺失，既不选其中一条，也不进入分位样本；
 * - 分位 = 不高于当前值的有效样本数 / 有效样本数，并列都计；
 * - 窗口只计同源、去重清晰、正有限历史值；序列起点不覆盖窗口时明确标不足。
 */
export const SECTOR_VALUATION_VERSION = "sector-valuation-1";
const PE_GROUP = 5;
const PB_GROUP = 6;
const READ_CONCURRENCY = 4;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 4;

type Block = Awaited<ReturnType<typeof readTdxLocalBlocks>>["blocks"][number];
type SeriesRecords = Awaited<
  ReturnType<typeof readLocalFinancialSeries>
>["records"];

function minusYears(date: string, years: number) {
  const [y, m, d] = date.split("-").map(Number);
  const targetYear = y! - years;
  // 2 月 29 日往前推到不存在的日期时，退回当月最后一天。
  const lastDay = new Date(Date.UTC(targetYear, m!, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(targetYear).padStart(4, "0")}-${pad(m!)}-${pad(Math.min(d!, lastDay))}`;
}

function missingFile(error: unknown) {
  if ((error as { code?: string } | null)?.code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|no such file|文件不存在/i.test(message);
}

function emptyWindow(
  years: 5 | 10 | "all",
  reason: string,
): SectorValuationWindow {
  return {
    years,
    windowStart: null,
    sampleStart: null,
    complete: false,
    samples: 0,
    notAbove: null,
    percentile: null,
    reason,
  };
}

function emptyMetric(
  reason: string,
  missing: SectorValuationMetric["missing"],
) {
  return {
    value: null,
    missing,
    y5: emptyWindow(5, reason),
    y10: emptyWindow(10, reason),
    yAll: emptyWindow("all", reason),
  } satisfies SectorValuationMetric;
}

/** 同组同日的多条记录视为歧义；单条记录才参与当前值与分位样本。 */
function groupByDate(records: SeriesRecords, group: number, asOf: string) {
  const byDate = new Map<string, number[]>();
  for (const record of records) {
    if (record.group !== group || record.date === null) continue;
    const date = financialDate(record.date);
    if (!date || date > asOf) continue;
    const values = byDate.get(date) ?? [];
    values.push(record.values[0]!);
    byDate.set(date, values);
  }
  return byDate;
}

function windowSummary({
  byDate,
  observation,
  current,
  sourceFirst,
  years,
}: {
  byDate: Map<string, number[]>;
  observation: string;
  current: number | null;
  sourceFirst: string | null;
  years: 5 | 10 | "all";
}): SectorValuationWindow {
  const windowStart =
    years === "all" ? sourceFirst : minusYears(observation, years);
  const entries = [...byDate.entries()]
    .filter(
      ([date, values]) =>
        values.length === 1 &&
        Number.isFinite(values[0]) &&
        values[0]! > 0 &&
        (windowStart === null || date >= windowStart) &&
        date <= observation,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const samples = entries.length;
  const sampleStart = entries[0]?.[0] ?? null;
  const complete =
    years === "all"
      ? samples > 0
      : sourceFirst !== null && sourceFirst <= windowStart!;
  if (current === null || !Number.isFinite(current) || current <= 0)
    return {
      years,
      windowStart,
      sampleStart,
      complete,
      samples,
      notAbove: null,
      percentile: null,
      reason: "当前倍数缺失或非正，不计算分位",
    };
  if (years !== "all" && !complete)
    return {
      years,
      windowStart,
      sampleStart,
      complete,
      samples,
      notAbove: null,
      percentile: null,
      reason: `本地序列起点 ${sourceFirst ?? "未知"} 未覆盖 ${years} 年窗口（窗口起点 ${windowStart}）`,
    };
  if (!samples)
    return {
      years,
      windowStart,
      sampleStart,
      complete,
      samples,
      notAbove: null,
      percentile: null,
      reason:
        years === "all" ? "全历史没有有效正历史值" : "窗口内没有有效正历史值",
    };
  const notAbove = entries.filter(([, values]) => values[0]! <= current).length;
  return {
    years,
    windowStart,
    sampleStart,
    complete,
    samples,
    notAbove,
    percentile: (notAbove / samples) * 100,
    reason: null,
  };
}

/** 每组独立判覆盖：最早且无同日歧义的记录日才证明该列历史起点。 */
function firstUnambiguous(byDate: Map<string, number[]>) {
  return (
    [...byDate.entries()]
      .filter(([, values]) => values.length === 1)
      .map(([date]) => date)
      .sort()[0] ?? null
  );
}

function metricSummary({
  byDate,
  observation,
  sourceFirst,
}: {
  byDate: Map<string, number[]>;
  observation: string | null;
  sourceFirst: string | null;
}): SectorValuationMetric {
  if (!observation) return emptyMetric("截止日前没有有效记录日期", "no-record");
  const records = byDate.get(observation);
  let value: number | null = null;
  let missing: SectorValuationMetric["missing"] = null;
  if (!records) missing = "missing-on-date";
  else if (records.length > 1) missing = "duplicate";
  else value = records[0]!;
  return {
    value,
    missing,
    y5: windowSummary({
      byDate,
      observation,
      current: value,
      sourceFirst,
      years: 5,
    }),
    y10: windowSummary({
      byDate,
      observation,
      current: value,
      sourceFirst,
      years: 10,
    }),
    yAll: windowSummary({
      byDate,
      observation,
      current: value,
      sourceFirst,
      years: "all",
    }),
  };
}

/** 纯摘要：给定同一板块的原始记录，对齐两值并计算分位。 */
export function summarizeSectorValuation({
  category,
  classification,
  code,
  name,
  records,
  asOf,
}: {
  category: SectorValuationCategory;
  classification: "tdx-research" | "tdx-concept";
  code: string | null;
  name: string;
  records: SeriesRecords;
  asOf: string;
}): SectorValuationRow {
  const pe = groupByDate(records, PE_GROUP, asOf);
  const pb = groupByDate(records, PB_GROUP, asOf);
  const dates = [...new Set([...pe.keys(), ...pb.keys()])].sort();
  const observation = dates.at(-1) ?? null;
  const sourceFirst = dates[0] ?? null;
  const sourceLast = observation;
  // 序列可能只有其他组号；没有 BK5/BK6 记录时明确为不可用，不冒充空估值。
  if (!observation)
    return {
      category,
      classification,
      code,
      name,
      symbol: code ? `sh${code}` : null,
      status: "unavailable",
      reason: "本地序列没有 BK5/BK6 有效日期记录",
      date: null,
      pe: emptyMetric("本地序列没有 BK5/BK6 有效日期记录", "no-record"),
      pb: emptyMetric("本地序列没有 BK5/BK6 有效日期记录", "no-record"),
      sourceFirst,
      sourceLast,
    };
  return {
    category,
    classification,
    code,
    name,
    symbol: code ? `sh${code}` : null,
    status: "ok",
    reason: null,
    date: observation,
    pe: metricSummary({
      byDate: pe,
      observation,
      sourceFirst: firstUnambiguous(pe),
    }),
    pb: metricSummary({
      byDate: pb,
      observation,
      sourceFirst: firstUnambiguous(pb),
    }),
    sourceFirst,
    sourceLast,
  };
}

function unavailableRow(
  block: Block,
  reason: string,
  missing: SectorValuationMetric["missing"] = null,
): SectorValuationRow {
  return {
    category: block.category as SectorValuationCategory,
    classification: block.classification as "tdx-research" | "tdx-concept",
    code: block.code,
    name: block.name,
    symbol: block.code ? `sh${block.code}` : null,
    status: "unavailable",
    reason,
    date: null,
    pe: emptyMetric(reason, missing),
    pb: emptyMetric(reason, missing),
    sourceFirst: null,
    sourceLast: null,
  };
}

const slots = new PrioritySlots(READ_CONCURRENCY);
const summaries = new Map<string, { at: number; summary: CategorySummary }>();
type CategorySummary = {
  category: SectorValuationCategory;
  asOf: string;
  blocksHash: string;
  counts: { industry: number; concept: number };
  coverage: SectorValuationResult["coverage"];
  observation: SectorValuationResult["observation"];
  rows: SectorValuationRow[];
  warning: string | null;
};

function cached(key: string) {
  const hit = summaries.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    summaries.delete(key);
    return null;
  }
  return hit.summary;
}

function remember(key: string, summary: CategorySummary) {
  summaries.delete(key);
  summaries.set(key, { at: Date.now(), summary });
  for (const [old] of summaries)
    if (summaries.size <= CACHE_LIMIT) break;
    else summaries.delete(old);
}

async function readRow(
  root: string,
  block: Block,
  asOf: string,
): Promise<SectorValuationRow> {
  if (!block.code || !/^\d{6}$/.test(block.code))
    return unavailableRow(block, "板块定义缺少代码，无法定位本地序列");
  const release = await slots.acquire(1);
  try {
    const source = await readLocalFinancialSeries(root, `sh${block.code}`);
    if (source.namespace !== "BK")
      return unavailableRow(
        block,
        `本地序列未归类为板块（${source.namespace}），不按 GP/SC 组号解释估值`,
      );
    return summarizeSectorValuation({
      category: block.category as SectorValuationCategory,
      classification: block.classification as "tdx-research" | "tdx-concept",
      code: block.code,
      name: block.name,
      records: source.records,
      asOf,
    });
  } catch (error) {
    if (missingFile(error))
      return unavailableRow(block, "本地未下载该板块序列文件", "no-file");
    return unavailableRow(
      block,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    release();
  }
}

async function loadSummary(
  root: string,
  blocksHash: string,
  blocks: Block[],
  counts: CategorySummary["counts"],
  category: SectorValuationCategory,
  asOf: string,
): Promise<CategorySummary> {
  const selected = blocks.filter((block) => block.category === category);
  const rows = await Promise.all(
    selected.map((block) => readRow(root, block, asOf)),
  );
  const readable = rows.filter((row) => row.status === "ok");
  const firsts = readable
    .map((row) => row.sourceFirst)
    .filter((date): date is string => date !== null)
    .sort();
  const lasts = readable
    .map((row) => row.sourceLast)
    .filter((date): date is string => date !== null)
    .sort();
  const observationDate = lasts.at(-1) ?? null;
  return {
    category,
    asOf,
    blocksHash,
    counts,
    coverage: {
      blocks: rows.length,
      readable: readable.length,
      first: firsts[0] ?? null,
      last: lasts.at(-1) ?? null,
    },
    observation: {
      date: observationDate,
      window5: observationDate ? minusYears(observationDate, 5) : null,
      window10: observationDate ? minusYears(observationDate, 10) : null,
    },
    rows,
    warning:
      readable.length < rows.length
        ? `${rows.length - readable.length} 个板块的本地序列不可用，逐行显示原因`
        : null,
  };
}

function sortValue(row: SectorValuationRow, sort: SectorValuationSort) {
  const metric = sort.startsWith("pe") ? row.pe : row.pb;
  if (sort === "pe" || sort === "pb")
    return metric.value !== null &&
      Number.isFinite(metric.value) &&
      metric.value > 0
      ? metric.value
      : null;
  if (sort.endsWith("5")) return metric.y5.percentile;
  if (sort.endsWith("10")) return metric.y10.percentile;
  return metric.yAll?.percentile ?? null;
}

function compareRows(
  a: SectorValuationRow,
  b: SectorValuationRow,
  sort: SectorValuationSort,
  descending: boolean,
) {
  const left = sortValue(a, sort);
  const right = sortValue(b, sort);
  if (left === null || right === null) {
    if (left !== right) return left === null ? 1 : -1;
  } else if (left !== right) {
    return descending ? right - left : left - right;
  }
  const code = (a.code ?? "").localeCompare(b.code ?? "");
  return (
    code || a.name.localeCompare(b.name) || a.category.localeCompare(b.category)
  );
}

/** 全分类排序后再分页；未知与非正当前值始终置后。 */
export function sortAndPageSectorValuation(
  rows: readonly SectorValuationRow[],
  sort: SectorValuationSort,
  descending: boolean,
  pageIndex: number,
  pageSize: number,
) {
  const sorted = [...rows].sort((a, b) => compareRows(a, b, sort, descending));
  return sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
}

function contextFailure(
  input: ReturnType<typeof sectorValuationInput.parse>,
  state: "source-unconfigured" | "blocks-unavailable",
  reason: string,
  requestedDate: string,
): SectorValuationResult {
  return {
    version: SECTOR_VALUATION_VERSION,
    available: false,
    state,
    reason,
    requestedDate,
    category: input.category,
    classification:
      input.category === "industry" ? "tdx-research" : "tdx-concept",
    counts: { industry: 0, concept: 0 },
    coverage: { blocks: 0, readable: 0, first: null, last: null },
    observation: { date: null, window5: null, window10: null },
    rows: [],
    total: 0,
    pageIndex: input.pageIndex,
    pageSize: input.pageSize,
    sort: input.sort,
    descending: input.descending,
    cached: false,
    warning: null,
    generatedAt: Date.now(),
  };
}

export async function sectorValuation(
  root: string,
  rawInput: unknown,
): Promise<SectorValuationResult> {
  const input = sectorValuationInput.parse(rawInput);
  const requestedDate = input.asOf ?? beijingCalendarDate();
  if (!root.trim())
    return contextFailure(
      input,
      "source-unconfigured",
      "通达信本地目录尚未配置",
      requestedDate,
    );
  try {
    resolveTdxRoot(root);
  } catch (error) {
    if ((error as { code?: string }).code === "TDX_ROOT_REQUIRED")
      return contextFailure(
        input,
        "source-unconfigured",
        "通达信本地目录尚未配置",
        requestedDate,
      );
    throw error;
  }

  let source: Awaited<ReturnType<typeof readTdxLocalBlocks>>;
  try {
    source = await readTdxLocalBlocks(root);
  } catch (error) {
    return contextFailure(
      input,
      "blocks-unavailable",
      `板块主档不可用：${error instanceof Error ? error.message : String(error)}`,
      requestedDate,
    );
  }
  const counts = {
    industry: source.blocks.filter((block) => block.category === "industry")
      .length,
    concept: source.blocks.filter((block) => block.category === "concept")
      .length,
  };
  const key = JSON.stringify([
    root,
    input.category,
    requestedDate,
    source.hash,
  ]);
  let summary = input.refresh ? null : cached(key);
  const isCached = summary !== null;
  if (!summary) {
    summary = await loadSummary(
      root,
      source.hash,
      source.blocks,
      counts,
      input.category,
      requestedDate,
    );
    remember(key, summary);
  }
  return {
    version: SECTOR_VALUATION_VERSION,
    available: true,
    state: "ok",
    reason: null,
    requestedDate,
    category: input.category,
    classification:
      input.category === "industry" ? "tdx-research" : "tdx-concept",
    counts: summary.counts,
    coverage: summary.coverage,
    observation: summary.observation,
    rows: sortAndPageSectorValuation(
      summary.rows,
      input.sort,
      input.descending,
      input.pageIndex,
      input.pageSize,
    ),
    total: summary.rows.length,
    pageIndex: input.pageIndex,
    pageSize: input.pageSize,
    sort: input.sort,
    descending: input.descending,
    cached: isCached,
    warning: summary.warning,
    generatedAt: Date.now(),
  };
}
