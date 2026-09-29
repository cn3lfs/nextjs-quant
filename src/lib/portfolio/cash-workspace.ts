import { z } from "zod";
import { sortTableRows } from "../common/server-sort";
import {
  cashReconciliationPageSchema,
  type CashReconciliation,
  type CashDaySource,
} from "./cash-reconciliation";

const date = z.string().date();
export const cashWorkspacePageSchema = cashReconciliationPageSchema
  .extend({
    start: date.optional(),
    end: date.optional(),
  })
  .refine((value) => !value.start || !value.end || value.start <= value.end, {
    message: "起始日期不能晚于结束日期",
    path: ["end"],
  });
export const cashEvidencePageSchema = z.object({
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(20),
});
export const cashDateSchema = date;

function page<T>(
  rows: readonly T[],
  input: z.input<typeof cashEvidencePageSchema>,
) {
  const { pageIndex: requested, pageSize } =
    cashEvidencePageSchema.parse(input);
  const pageIndex = Math.min(
    requested,
    Math.max(0, Math.ceil(rows.length / pageSize) - 1),
  );
  return {
    rows: rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    total: rows.length,
    pageIndex,
    pageSize,
  };
}

/** Display filters never become replay inputs. No evidence arrays escape this projection. */
export function cashWorkspacePage(
  result: CashReconciliation,
  input: z.input<typeof cashWorkspacePageSchema> = {},
) {
  const options = cashWorkspacePageSchema.parse(input);
  const filtered = result.days
    .filter(
      (day) =>
        (options.status === "all" || day.status === options.status) &&
        (!options.start || day.date >= options.start) &&
        (!options.end || day.date <= options.end),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const ordered = sortTableRows(filtered, options.order, {
    date: (day) => day.date,
    status: (day) => day.status,
    statementCash: (day) => day.statementCash,
    projectedCash: (day) => day.projectedCash,
    difference: (day) => day.difference,
    reason: (day) => day.reason,
    evidence: (day) => day.evidence.length,
  });
  const selected = page(ordered, options);
  return {
    basis: result.basis,
    summary: result.summary,
    opening: {
      cash: result.opening.cash,
      date: result.opening.date,
      count: result.opening.evidence.length,
    },
    diagnosticCount: result.diagnostics.length,
    ...selected,
    rows: selected.rows.map(({ evidence, ...day }) => ({
      ...day,
      sourceCount: evidence.length,
    })),
  };
}

function sourceSummary(source: CashDaySource) {
  const { rows, rowIndexes: _rowIndexes, ...metadata } = source;
  return { ...metadata, rowCount: rows.length };
}

export function cashWorkspaceDate(
  result: CashReconciliation,
  selectedDate: string,
  input: z.input<typeof cashEvidencePageSchema> = {},
) {
  const selected = date.parse(selectedDate);
  const day = result.days.find((value) => value.date === selected);
  if (!day) throw new Error("该日期已不存在，请刷新现金核对");
  const { evidence, ...metadata } = day;
  const sources = page(evidence, input);
  return {
    ...metadata,
    sources: { ...sources, rows: sources.rows.map(sourceSummary) },
  };
}

export function cashWorkspaceRows(
  result: CashReconciliation,
  selectedDate: string,
  batchId: string,
  input: z.input<typeof cashEvidencePageSchema> = {},
) {
  const selected = date.parse(selectedDate);
  const day = result.days.find((value) => value.date === selected);
  const source = day?.evidence.find((value) => value.batchId === batchId);
  if (!source) throw new Error("该来源已不存在，请刷新现金核对");
  return {
    date: selectedDate,
    source: sourceSummary(source),
    ...page(source.rows, input),
  };
}

export function cashWorkspaceOpening(
  result: CashReconciliation,
  input: z.input<typeof cashEvidencePageSchema> = {},
) {
  return {
    cash: result.opening.cash,
    date: result.opening.date,
    ...page(result.opening.evidence, input),
  };
}

export function cashWorkspaceDiagnostics(
  result: CashReconciliation,
  input: z.input<typeof cashEvidencePageSchema> = {},
) {
  return page(result.diagnostics, input);
}
