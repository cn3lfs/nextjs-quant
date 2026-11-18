import { createHash } from "node:crypto";
import {
  financialTheoryFieldIds,
  rankFinancialTheory,
} from "trading-strategies/research/financial-theory";
import {
  readFinancialPoolHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";
import { localFinancialTheory } from "./financial-theory-adapter";

export function financialRebalanceDates(
  tradingDays: readonly string[],
  firstYear: number,
  lastYear: number,
) {
  if (
    !Number.isInteger(firstYear) ||
    !Number.isInteger(lastYear) ||
    lastYear < firstYear
  )
    throw new Error("年度范围非法");
  if (
    tradingDays.some(
      (day, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        (i > 0 && day <= tradingDays[i - 1]!),
    )
  )
    throw new Error("交易日历必须严格递增且不重复");
  const result: { year: number; asOf: string; executeAt: string }[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const index = tradingDays.findIndex((day) => day.startsWith(`${year}-`));
    if (index <= 0) throw new Error(`${year}缺少首交易日或前一完成交易日`);
    result.push({
      year,
      asOf: tradingDays[index - 1]!,
      executeAt: tradingDays[index]!,
    });
  }
  return result;
}

/** Annual signals only. The caller owns raw-price execution, costs and account constraints. */
export async function loadFinancialTheoryYear(
  input: {
    root: string;
    symbols: readonly string[];
    asOf: string;
    executeAt: string;
    calendarHash: string;
    poolHash: string;
    researchCodeHash: string;
  },
  progress: (done: number, total: number) => void = () => {},
  signal?: AbortSignal,
) {
  if (
    input.asOf >= input.executeAt ||
    !input.calendarHash ||
    !input.poolHash ||
    !input.researchCodeHash
  )
    throw new Error("年度信号须有事前日期与冻结日历/证券池身份");
  if (new Set(input.symbols).size !== input.symbols.length)
    throw new Error("年度证券池重复");
  const history = await readFinancialPoolHistory(input.root, input.symbols, {
    asOf: input.asOf,
    strict: true,
    limit: 16,
    fieldIds: [...financialTheoryFieldIds],
    signal,
  });
  const rows = [];
  for (let i = 0; i < input.symbols.length; i++) {
    signal?.throwIfAborted();
    const symbol = input.symbols[i]!,
      reports = history.reports.get(symbol) ?? [];
    let stock: Awaited<ReturnType<typeof readLocalFinancialSeries>> | undefined;
    let seriesError: string | null = null;
    try {
      stock = await readLocalFinancialSeries(input.root, symbol);
    } catch (error) {
      seriesError = error instanceof Error ? error.message : String(error);
    }
    const result = localFinancialTheory(reports, input.asOf, true, stock);
    rows.push({
      symbol,
      result,
      seriesError,
      sourceReports: reports.map(({ fields: _, ...metadata }) => metadata),
      seriesHash: stock?.sourceSha256 ?? null,
    });
    history.reports.delete(symbol);
    progress(i + 1, input.symbols.length);
  }
  const selections = {
    fScore: rankFinancialTheory(rows, "f-score"),
    magicFormula: rankFinancialTheory(rows, "magic-formula"),
  };
  const groups: Record<string, { known: number; passed: number }> = {};
  for (const row of rows)
    for (const check of row.result.fScore.checks) {
      const group = (groups[check.id] ??= { known: 0, passed: 0 });
      group.known += Number(check.matched !== null);
      group.passed += Number(check.matched === true);
    }
  const content = {
    version: "financial-theory-year-v1",
    asOf: input.asOf,
    executeAt: input.executeAt,
    poolHash: input.poolHash,
    researchCodeHash: input.researchCodeHash,
    calendarHash: input.calendarHash,
    symbols: [...input.symbols],
    rows,
    selections,
    issues: history.issues,
    counts: {
      total: rows.length,
      annualReport: rows.filter((r) => r.result.reportDate).length,
      fScoreComplete: rows.filter((r) => r.result.fScore.score !== null).length,
      magicEligible: rows.filter((r) => r.result.magic.eligible).length,
      groups,
    },
    warning:
      "当前下载的历史财报与当前冻结成分，仅开发验证；不认证首次披露、无偏绩效或新留出。执行引擎须在executeAt或后续合法时点交易，不能在asOf收盘前使用这些信号。",
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
