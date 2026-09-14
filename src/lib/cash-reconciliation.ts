import { z } from "zod";
import {
  parseDeliveryDate,
  parseDeliveryNumber,
  parseDeliveryTime,
  type ColumnMapping,
  type DeliveryField,
} from "./delivery-import";

/** Retained import evidence only. No account identifiers or raw cell text are returned. */
export type CashEvidenceBatch = {
  id: string;
  fileHash: string;
  payload: {
    mapping: ColumnMapping;
    rawRows: string[][];
    statementOpeningCash?: number | null;
  };
};
export type CashEvidenceRow = {
  rowIndex: number;
  time: string | null;
  balanceCash: number | null;
  netAmount: number | null;
};
export type CashDaySource = {
  batchId: string;
  fileHash: string;
  rowIndexes: number[];
  rows: CashEvidenceRow[];
  order: "single-row" | "balance-chain" | "timestamp-chain" | null;
  openingCash: number | null;
  statementCash: number | null;
  reason: string | null;
};
export type StatementCashEvidence = {
  days: { date: string; sources: CashDaySource[] }[];
  openings: {
    batchId: string;
    fileHash: string;
    date: string | null;
    value: number | null;
  }[];
  diagnostics: { batchId: string; rowIndex: number | null; reason: string }[];
};

const cents = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) ? rounded : null;
};

/** Every row is an edge from (balance - movement) to balance. A connected
 * balance chain with unique endpoints proves the closing value even when the
 * export reverses dates, ties timestamps, or changes the within-day row order.
 * A circuit does not prove its endpoint; distinct, consistent timestamps may.
 * This is evidence validation, never a replacement order for the NAV replay. */
function closingEvidence(
  rows: CashEvidenceRow[],
): Pick<CashDaySource, "order" | "openingCash" | "statementCash" | "reason"> {
  const unavailable = (reason: string) => ({
    order: null,
    openingCash: null,
    statementCash: null,
    reason,
  });
  if (rows.some((row) => cents(row.balanceCash) === null))
    return unavailable("该日存在缺失或非法资金余额，不能认定日末余额");
  if (rows.length === 1) {
    const row = rows[0]!;
    const balance = cents(row.balanceCash)!;
    const amount = cents(row.netAmount);
    if (amount !== null && !Number.isSafeInteger(balance - amount))
      return unavailable("资金发生额超出分精度安全范围");
    return {
      order: "single-row",
      openingCash: amount === null ? null : (balance - amount) / 100,
      statementCash: balance / 100,
      reason: null,
    };
  }
  if (rows.some((row) => cents(row.netAmount) === null))
    return unavailable("该日资金发生额缺失，无法核实余额链及日末顺序");
  const edges = rows.map((row) => ({
    row,
    before: cents(row.balanceCash)! - cents(row.netAmount)!,
    after: cents(row.balanceCash)!,
  }));
  if (edges.some((edge) => !Number.isSafeInteger(edge.before)))
    return unavailable("资金发生额超出分精度安全范围");
  const degrees = new Map<number, number>();
  const neighbors = new Map<number, Set<number>>();
  for (const edge of edges) {
    degrees.set(edge.before, (degrees.get(edge.before) ?? 0) + 1);
    degrees.set(edge.after, (degrees.get(edge.after) ?? 0) - 1);
    for (const [a, b] of [
      [edge.before, edge.after],
      [edge.after, edge.before],
    ]) {
      const group = neighbors.get(a!) ?? new Set<number>();
      group.add(b!);
      neighbors.set(a!, group);
    }
  }
  const visited = new Set<number>();
  const pending = [edges[0]!.before];
  while (pending.length) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    pending.push(...neighbors.get(value)!);
  }
  if (visited.size !== degrees.size)
    return unavailable("该日原始余额链不连通，需核对缺失流水或导出顺序");
  const starts = [...degrees].filter(([, degree]) => degree === 1);
  const ends = [...degrees].filter(([, degree]) => degree === -1);
  if (
    starts.length === 1 &&
    ends.length === 1 &&
    [...degrees.values()].every((degree) => Math.abs(degree) <= 1)
  )
    return {
      order: "balance-chain",
      openingCash: starts[0]![0] / 100,
      statementCash: ends[0]![0] / 100,
      reason: null,
    };
  if ([...degrees.values()].some((degree) => degree !== 0))
    return unavailable("该日余额恒等式无法组成唯一收尾的完整链，需核对原始行");
  if (degrees.size === 1)
    return {
      order: "balance-chain",
      openingCash: edges[0]!.before / 100,
      statementCash: edges[0]!.after / 100,
      reason: null,
    };
  if (
    rows.every((row) => row.time !== null) &&
    new Set(rows.map((row) => row.time)).size === rows.length
  ) {
    const chronological = [...edges].sort((a, b) =>
      a.row.time!.localeCompare(b.row.time!),
    );
    if (
      chronological.every(
        (edge, index) =>
          index === 0 || chronological[index - 1]!.after === edge.before,
      )
    )
      return {
        order: "timestamp-chain",
        openingCash: chronological[0]!.before / 100,
        statementCash: chronological.at(-1)!.after / 100,
        reason: null,
      };
  }
  return unavailable("该日余额链为循环且缺少独立时间顺序，日末余额待核对");
}

export function extractStatementCashEvidence(
  batches: readonly CashEvidenceBatch[],
): StatementCashEvidence {
  const days = new Map<string, CashDaySource[]>();
  const diagnostics: StatementCashEvidence["diagnostics"] = [];
  const openings: StatementCashEvidence["openings"] = [];
  // Stable order makes offline export independent of database listing order.
  for (const batch of [...batches].sort((a, b) => a.id.localeCompare(b.id))) {
    const columns = batch.payload.mapping.columns;
    if (columns.balanceCash === undefined) continue;
    const grouped = new Map<string, CashEvidenceRow[]>();
    let invalidDate = false;
    const invalidCurrency = new Set<string>();
    for (const [index, cells] of batch.payload.rawRows.entries()) {
      const at = (field: DeliveryField) =>
        columns[field] === undefined ? "" : (cells[columns[field]!] ?? "");
      if (cells.every((cell) => !cell.trim())) continue;
      const date = parseDeliveryDate(at("tradeDate"));
      if (!date) {
        invalidDate = true;
        diagnostics.push({
          batchId: batch.id,
          rowIndex: index + 1,
          reason: "原始余额行日期无效，无法确认其所属交易日",
        });
        continue;
      }
      const currency = at("currency").trim().toUpperCase();
      if (
        currency &&
        !["CNY", "RMB", "人民币", "人民币元", "元"].includes(currency)
      )
        invalidCurrency.add(date);
      const rows = grouped.get(date) ?? [];
      rows.push({
        rowIndex: index + 1,
        time: parseDeliveryTime(at("tradeTime")),
        balanceCash: parseDeliveryNumber(at("balanceCash")),
        netAmount: parseDeliveryNumber(at("netAmount")),
      });
      grouped.set(date, rows);
    }
    const dates = [...grouped.keys()].sort();
    if (batch.payload.statementOpeningCash !== undefined)
      openings.push({
        batchId: batch.id,
        fileHash: batch.fileHash,
        date: invalidDate ? null : (dates[0] ?? null),
        value: batch.payload.statementOpeningCash,
      });
    for (const date of dates) {
      const rows = grouped.get(date)!;
      const closing = closingEvidence(rows);
      const reason = invalidDate
        ? "该批次含无法定位日期的原始行，日末覆盖待核对"
        : invalidCurrency.has(date)
          ? "该日币种不是明确的人民币，未与人民币账本比较"
          : null;
      const sources = days.get(date) ?? [];
      sources.push({
        batchId: batch.id,
        fileHash: batch.fileHash,
        rowIndexes: rows.map((row) => row.rowIndex),
        rows,
        ...closing,
        ...(reason
          ? { order: null, openingCash: null, statementCash: null, reason }
          : {}),
      });
      days.set(date, sources);
    }
  }
  return {
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, sources]) => ({ date, sources })),
    openings,
    diagnostics,
  };
}

export const cashReconciliationStatuses = [
  "matched",
  "difference",
  "unavailable",
  "conflict",
] as const;
export type CashReconciliationStatus =
  (typeof cashReconciliationStatuses)[number];
export type CashReconciliationDay = {
  date: string;
  status: CashReconciliationStatus;
  statementCash: number | null;
  projectedCash: number | null;
  difference: number | null;
  reason: string | null;
  evidence: CashDaySource[];
};

export function reconcileCashDays(input: {
  evidence: StatementCashEvidence;
  projectedDays: readonly { date: string; cash: number | null }[];
  openingCash: number | null;
}) {
  const projected = new Map(
    input.projectedDays.map((day) => [day.date, day.cash]),
  );
  const evidence = new Map(
    input.evidence.days.map((day) => [day.date, day.sources]),
  );
  const dates = [...new Set([...projected.keys(), ...evidence.keys()])].sort();
  const days: CashReconciliationDay[] = dates.map((date) => {
    const sources = evidence.get(date) ?? [];
    const values = [
      ...new Set(
        sources.flatMap((source) =>
          source.statementCash === null ? [] : [source.statementCash],
        ),
      ),
    ];
    const projectedCash = projected.get(date) ?? null;
    const base = { date, projectedCash, evidence: sources, difference: null };
    if (values.length > 1)
      return {
        ...base,
        status: "conflict",
        statementCash: null,
        reason: "多个来源的可核实日末余额不一致，未自动选用任何来源",
      };
    const statementCash = values[0] ?? null;
    if (!sources.length)
      return {
        ...base,
        status: "unavailable",
        statementCash,
        reason: "该日无柜台余额证据，未沿用前日余额",
      };
    if (sources.some((source) => source.statementCash === null))
      return {
        ...base,
        status: "unavailable",
        statementCash,
        reason: "存在日末顺序或余额待核对的来源，未忽略该来源",
      };
    const actual = cents(statementCash),
      expected = cents(projectedCash);
    if (actual === null || expected === null)
      return {
        ...base,
        status: "unavailable",
        statementCash,
        reason: "该日账本推算现金不可得或不在复盘日期范围",
      };
    const difference = (actual - expected) / 100;
    return {
      ...base,
      status: difference === 0 ? "matched" : "difference",
      statementCash,
      difference,
      reason:
        difference === 0
          ? null
          : "柜台日末余额与独立账本推算现金不一致，未自动平账",
    };
  });
  const differences = days.filter((day) => day.status === "difference");
  const firstDate =
    input.projectedDays.map((day) => day.date).sort()[0] ?? null;
  return {
    version: 1 as const,
    basis:
      "仅核对已导入文件覆盖的人民币日末现金；分精度比较；推算现金不采用后续柜台余额。余额链只证明原始行的收尾，不证明流水完整或真实盘中时序；不改变NAV、期初现金、分类或交易顺序。",
    opening: {
      cash: input.openingCash,
      date: firstDate,
      evidence: input.evidence.openings.map((opening) => ({
        ...opening,
        difference:
          firstDate !== null &&
          opening.date === firstDate &&
          cents(opening.value) !== null &&
          cents(input.openingCash) !== null
            ? (cents(opening.value)! - cents(input.openingCash)!) / 100
            : null,
        reason:
          firstDate === null || opening.date === null
            ? "批次或复盘起点未知，未比较期初现金"
            : opening.date !== firstDate
              ? "批次起点与复盘起点不同，未比较期初现金"
              : cents(opening.value) === null
                ? "批次期初余额证据缺失或非法"
                : cents(input.openingCash) === null
                  ? "复盘期初现金未知或非法"
                  : null,
      })),
    },
    summary: {
      days: days.length,
      comparableDays: days.filter(
        (day) => day.status === "matched" || day.status === "difference",
      ).length,
      matchedDays: days.filter((day) => day.status === "matched").length,
      differenceDays: differences.length,
      unavailableDays: days.filter((day) => day.status === "unavailable")
        .length,
      conflictDays: days.filter((day) => day.status === "conflict").length,
      firstDifferenceDate: differences[0]?.date ?? null,
      maximumAbsoluteDifference: differences.length
        ? Math.max(...differences.map((day) => Math.abs(day.difference!)))
        : null,
      evidenceStart: input.evidence.days[0]?.date ?? null,
      evidenceEnd: input.evidence.days.at(-1)?.date ?? null,
    },
    days,
    diagnostics: input.evidence.diagnostics,
  };
}
export type CashReconciliation = ReturnType<typeof reconcileCashDays>;
export const cashReconciliationPageSchema = z.object({
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(20),
  status: z.enum(["all", ...cashReconciliationStatuses]).default("all"),
});
export function cashReconciliationPage(
  result: CashReconciliation,
  input: z.input<typeof cashReconciliationPageSchema> = {},
) {
  const options = cashReconciliationPageSchema.parse(input);
  const rows = result.days.filter(
    (day) => options.status === "all" || day.status === options.status,
  );
  const { days: _days, ...metadata } = result;
  return {
    ...metadata,
    rows: rows.slice(
      options.pageIndex * options.pageSize,
      (options.pageIndex + 1) * options.pageSize,
    ),
    total: rows.length,
    pageIndex: options.pageIndex,
    pageSize: options.pageSize,
  };
}
