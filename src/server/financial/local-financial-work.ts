import { createHash } from "node:crypto";
import {
  calculateFactor,
  calculateLocalDataFactors,
  localDataFactorCatalog,
  localDataFactorVersion,
} from "trading-strategy-core/factors";
import {
  combineFinancialConditions,
  compareFinancialNumber,
  evaluateFinancialConditions,
  financialVersions,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import {
  financialScreenInput,
  type FinancialScreenInput,
} from "~/lib/financial/local-financial";
import {
  readFinancialPoolHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";

import { readBars } from "~/server/market/bar-store/read-bars";
import { auditLocalFinancialFiles } from "../data-sources/tdx/local-financial-audit";
import { buildLocalFinancialArchive } from "./local-financial-archive";

async function optionalSource<T>(read: () => Promise<T>) {
  try {
    return { value: await read(), error: null };
  } catch (error) {
    return {
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type LocalFinancialWork =
  | { type: "local-financial"; operation: "audit"; root: string }
  | {
      type: "local-financial";
      operation: "archive";
      root: string;
      symbol: string;
      reportDate?: string;
    }
  | {
      type: "local-financial";
      operation: "screen";
      root: string;
      input: FinancialScreenInput;
      symbols: string[];
      names: Record<string, string>;
      rps: {
        date: string;
        hash: string;
        values: Record<string, number>;
      } | null;
      poolSource: { hash: string; description: string };
    };

export async function runLocalFinancialScreen(
  work: Extract<LocalFinancialWork, { operation: "screen" }>,
  progress: (value: number, phase: string) => void = () => {},
  signal?: AbortSignal,
) {
  const input = financialScreenInput.parse(work.input);
  const dataDefinitions = (input.dataFactors ?? []).map((condition) =>
    localDataFactorCatalog.find((f) => f.id === condition.id)!,
  );
  const needs = (
    dependency: (typeof localDataFactorCatalog)[number]["dependencies"][number],
  ) => dataDefinitions.some((f) => f.dependencies.includes(dependency));
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const market = needs("market-series")
    ? await optionalSource(() =>
        readLocalFinancialSeries(work.root, "sh999999"),
      )
    : null;
  const block =
    needs("block-series") && input.factorBlockSymbol
      ? await optionalSource(() =>
          readLocalFinancialSeries(work.root, input.factorBlockSymbol!),
        )
      : null;
  const benchmark = needs("benchmark")
    ? await optionalSource(() =>
        readBars({
          instrument: { market: "cn-equity", symbol: "sh000300" },
          root: work.root,
          period: "day",
          adjustment: "none",
        }),
      )
    : null;
  const ids = [
    1,
    4,
    6,
    11,
    17,
    21,
    35,
    40,
    54,
    63,
    72,
    74,
    75,
    95,
    96,
    107,
    114,
    206,
    271,
    281,
    308,
    309,
    319,
    ...input.conditions
      .filter((c) => c.field.startsWith("FN"))
      .map((c) => +c.field.slice(2)),
  ];
  const needsHistory =
    input.conditions.some((c) => !c.field.startsWith("FN")) || needs("reports");
  const history =
    input.conditions.length || needs("reports")
      ? await readFinancialPoolHistory(work.root, work.symbols, {
          asOf: input.asOf,
          strict: input.strict,
          limit: needsHistory
            ? input.conditions.some((c) => c.field.includes("cagr"))
              ? 20
              : 8
            : 1,
          fieldIds: ids,
          signal,
          progress: (done, total) =>
            progress(
              Math.floor((done / total) * 70),
              `批量读取财报 ${done}/${total}`,
            ),
        })
      : { reports: new Map<string, FinancialReportSnapshot[]>(), issues: [] };
  const rows = [];
  for (let i = 0; i < work.symbols.length; i++) {
    signal?.throwIfAborted();
    const symbol = work.symbols[i]!,
      reports = history.reports.get(symbol) ?? [];
    const financial = evaluateFinancialConditions(
      reports,
      input.conditions,
      input.mode,
    );
    const daily =
      input.technical.length || needs("bars")
        ? await optionalSource(() =>
            readBars({
              instrument: { market: "cn-equity", symbol: symbol },
              root: work.root,
              period: "day",
              adjustment: "none",
            }),
          )
        : null;
    const stock = needs("stock-series")
      ? await optionalSource(() => readLocalFinancialSeries(work.root, symbol))
      : null;
    const sourceErrors = {
      "stock-series": stock?.error,
      "market-series": market?.error,
      "block-series":
        block?.error ??
        (!input.factorBlockSymbol ? "请指定板块因子标的代码" : null),
      bars: daily?.error ?? daily?.value?.sourceNote,
      benchmark: benchmark?.error ?? benchmark?.value?.sourceNote,
      reports: null,
    };
    const dataFactors = calculateLocalDataFactors({
      ids: (input.dataFactors ?? []).map((c) => c.id),
      asOf: input.asOf,
      stock: stock?.value,
      market: market?.value,
      block: block?.value,
      reports,
      bars:
        daily?.value && !daily.value.sourceNote ? daily.value.bars : undefined,
      benchmark:
        benchmark?.value && !benchmark.value.sourceNote
          ? benchmark.value.bars
          : undefined,
      barsHash: daily?.value?.hash,
      benchmarkHash: benchmark?.value?.hash,
    }).map((factor, index) => {
      const condition = input.dataFactors![index]!;
      const definition = dataDefinitions[index]!;
      const sourceError = definition.dependencies
        .map((dependency) => sourceErrors[dependency])
        .find(Boolean);
      const value = input.asOf < today && !sourceError ? factor.value : null;
      return {
        ...factor,
        ...condition,
        value,
        matched: compareFinancialNumber(
          value,
          condition.threshold,
          condition.operator,
        ),
        reason:
          input.asOf >= today
            ? "仅使用已结束的历史交易日，不能提前使用当日序列"
            : sourceError || factor.reason,
      };
    });
    const technical: {
      field: string;
      value: number | null;
      matched: boolean | null;
      reason: string | null;
      sourceSha256?: string;
    }[] = [];
    if (input.technical.length) {
      try {
        if (!daily?.value) throw new Error(daily?.error ?? "日线来源缺失");
        const snapshot = daily.value;
        const bars = snapshot.bars.filter(
          (bar) => bar.date.slice(0, 10) <= input.asOf,
        );
        // Price conditions use a completed daily bar, never a forming intraday tail.
        const last = bars.at(-1)?.date.slice(0, 10);
        for (const condition of input.technical) {
          const values = calculateFactor(bars, condition.left).values;
          const right =
            "factor" in condition.right
              ? calculateFactor(bars, condition.right.factor).values
              : bars.map(() =>
                  "constant" in condition.right
                    ? condition.right.constant
                    : null,
                );
          const value =
            last === input.asOf && input.asOf < today && !snapshot.sourceNote
              ? (values.at(-1) ?? null)
              : null;
          const rhs = right.at(-1) ?? null;
          let matched: boolean | null = null;
          if (rhs !== null && value !== null) {
            if (
              condition.operator === "cross-above" ||
              condition.operator === "cross-below"
            ) {
              const previous = values.at(-2),
                previousRight = right.at(-2);
              if (previous != null && previousRight != null)
                matched =
                  condition.operator === "cross-above"
                    ? previous <= previousRight && value > rhs
                    : previous >= previousRight && value < rhs;
            } else
              matched = compareFinancialNumber(value, rhs, condition.operator);
          }
          technical.push({
            field: condition.left.id,
            value,
            matched,
            reason:
              matched === null
                ? "当日完整日线、比较项、前值或预热证据不足；当日日线不提前使用"
                : null,
            sourceSha256: snapshot.hash,
          });
        }
      } catch (error) {
        technical.push({
          field: "technical",
          value: null,
          matched: null,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (input.rps) {
      const value =
        work.rps?.date === input.asOf
          ? (work.rps.values[symbol] ?? null)
          : null;
      technical.push({
        field: `RPS${input.rps.period}`,
        value,
        matched: compareFinancialNumber(value, input.rps.minimum, "gte"),
        reason:
          value === null ? "没有同一基准日、同一证券池口径的已保存RPS" : null,
        sourceSha256: work.rps?.hash,
      });
    }
    const matched = combineFinancialConditions(
      [
        ...(input.conditions.length ? [financial.matched] : []),
        ...technical.map((c) => c.matched),
        ...dataFactors.map((c) => c.matched),
      ],
      "all",
    );
    const latest = reports[0];
    rows.push({
      symbol,
      name: work.names[symbol] ?? symbol,
      matched,
      reportDate: latest?.reportDate ?? null,
      announcementDate: latest?.announcementDate ?? null,
      financial: financial.details,
      technical,
      dataFactors,
      evidence: reports.map((report) => ({
        reportDate: report.reportDate,
        announcementDate: report.announcementDate,
        availableFrom: report.availableFrom ?? null,
        calendar: report.calendar ?? null,
        sourceFilename: report.sourceFilename,
        sourceSha256: report.sourceSha256,
        recordOffset: report.recordOffset,
        fields: report.fields.map(({ code, raw, value, status }) => ({
          code,
          raw,
          value,
          status,
        })),
      })),
      reason:
        !latest && input.conditions.length
          ? "没有在所选日期前已披露的有效财报"
          : matched === null
            ? "至少一项必要条件缺证据"
            : null,
    });
    history.reports.delete(symbol);
    if (i % 20 === 0) {
      progress(
        70 + Math.floor(((i + 1) / work.symbols.length) * 29),
        `财务与技术条件 ${i + 1}/${work.symbols.length}`,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const content = {
    version: "local-financial-screen-v1",
    versions: financialVersions,
    dataFactorVersion: localDataFactorVersion,
    priceBasis: "local-unadjusted-day",
    input,
    symbols: work.symbols,
    poolSource: work.poolSource,
    rps: work.rps ? { date: work.rps.date, hash: work.rps.hash } : null,
    rows,
    issues: history.issues,
    counts: {
      total: rows.length,
      matched: rows.filter((r) => r.matched === true).length,
      rejected: rows.filter((r) => r.matched === false).length,
      unknown: rows.filter((r) => r.matched === null).length,
    },
    warning:
      "当前下载版本财报按公告日期过滤，未认证首次披露版本；当前成员证券池不代表历史证券池。本地序列只用同日记录，不前填，未认证源零值与首次公开时点；市场因子不是个股资金流。收益/风险使用未复权日线，除权跳变影响数值；Beta基准为沪深300。",
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  return {
    id: `local-financial-screen-${hash}`,
    hash,
    createdAt: Date.now(),
    ...content,
  };
}
export type LocalFinancialScreen = Awaited<
  ReturnType<typeof runLocalFinancialScreen>
>;
export async function executeLocalFinancialWork(
  work: LocalFinancialWork,
  progress: (value: number, phase: string) => void,
) {
  if (work.operation === "audit")
    return auditLocalFinancialFiles(work.root, {
      verifyZip: true,
      progress: (done, total) =>
        progress(
          Math.floor((done / total) * 100),
          `财务文件审计 ${done}/${total}`,
        ),
    });
  if (work.operation === "archive") {
    progress(5, "读取本地多期财报与来源证据");
    return buildLocalFinancialArchive(work.root, work.symbol, work.reportDate);
  }
  return runLocalFinancialScreen(work, progress);
}
