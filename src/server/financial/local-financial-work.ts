import { createHash } from "node:crypto";
import { calculateFactor } from "trading-strategy-core/factors";
import {
  combineFinancialConditions,
  compareFinancialNumber,
  evaluateFinancialConditions,
  financialVersions,
} from "trading-strategy-core/financial";
import {
  financialScreenInput,
  type FinancialScreenInput,
} from "~/lib/financial/local-financial";
import { readFinancialPoolHistory } from "../data-sources/tdx/local-financial-files";
import { readSnapshot } from "../data-sources/tdx/tdx";
import { auditLocalFinancialFiles } from "../data-sources/tdx/local-financial-audit";
import { buildLocalFinancialArchive } from "./local-financial-archive";

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
  const needsHistory = input.conditions.some((c) => !c.field.startsWith("FN"));
  const history = await readFinancialPoolHistory(work.root, work.symbols, {
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
  });
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
    const technical: {
      field: string;
      value: number | null;
      matched: boolean | null;
      reason: string | null;
      sourceSha256?: string;
    }[] = [];
    if (input.technical.length) {
      try {
        const snapshot = await readSnapshot(work.root, symbol, "day");
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
          const today = new Date(Date.now() + 8 * 3600000)
            .toISOString()
            .slice(0, 10);
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
    const matched = technical.length
      ? combineFinancialConditions(
          [financial.matched, ...technical.map((c) => c.matched)],
          "all",
        )
      : financial.matched;
    const latest = reports[0];
    rows.push({
      symbol,
      name: work.names[symbol] ?? symbol,
      matched,
      reportDate: latest?.reportDate ?? null,
      announcementDate: latest?.announcementDate ?? null,
      financial: financial.details,
      technical,
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
      reason: !latest
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
      "当前下载版本财报按公告日期过滤，未认证首次披露版本；当前成员证券池不代表历史证券池。",
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
