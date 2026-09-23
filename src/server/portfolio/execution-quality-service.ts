import { z } from "zod";
import { redactRow, mapDeliveryColumns } from "~/lib/research/evidence/delivery-import";
import {
  summarizeExecution,
  executionDiagnosticCategories,
  executionDiagnosticLabels,
  type ExecutionRow,
} from "~/lib/backtest/execution-quality";
import type { replayTradeReview } from "./trade-review-service";

export const executionSortFields = [
  "tradeDate",
  "code",
  "kind",
  "price",
  "vwap",
  "amount",
  "slippageBp",
  "slippageCost",
] as const;
export const executionPageSchema = z.object({
  account: z.string().trim().min(1),
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(10),
  sort: z.enum(executionSortFields).default("tradeDate"),
  desc: z.boolean().default(false),
  search: z.string().trim().max(100).default(""),
  side: z.enum(["all", "buy", "sell"]).default("all"),
  adverseOnly: z.boolean().default(false),
  diagnostic: z.enum(["all", ...executionDiagnosticCategories]).default("all"),
  start: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
    .default(""),
  end: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
    .default(""),
  minAmount: z.number().finite().min(0).default(0),
  group: z.enum(["code", "kind", "month"]).default("code"),
  groupPageIndex: z.number().int().min(0).max(1000000).default(0),
});
type Options = z.infer<typeof executionPageSchema>;
type Snapshot = ReturnType<typeof replayTradeReview>;
function selectedRows(snapshot: Snapshot, input: Options) {
  return snapshot.execution.rows
    .filter(
      (r) =>
        (!input.search || `${r.code} ${r.name ?? ""}`.includes(input.search)) &&
        (input.side === "all" || r.kind === input.side) &&
        (input.diagnostic === "all" ||
          r.diagnostic.category === input.diagnostic) &&
        (!input.adverseOnly ||
          (r.slippageBp.value !== null && r.slippageBp.value > 5)) &&
        (!input.start || r.tradeDate >= input.start) &&
        (!input.end || r.tradeDate <= input.end) &&
        (input.minAmount === 0 ||
          (r.amount.value !== null && r.amount.value >= input.minAmount)),
    )
    .sort((a, b) => {
      const field = (r: ExecutionRow) => {
        const v = r[input.sort];
        return typeof v === "object" ? v.value : v;
      };
      const x = field(a),
        y = field(b);
      if (x === null || y === null)
        return x === y ? a.fillIndex - b.fillIndex : x === null ? 1 : -1;
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y));
      return (input.desc ? -order : order) || a.fillIndex - b.fillIndex;
    });
}
export function pageExecutionQuality(snapshot: Snapshot, raw: unknown) {
  const input = executionPageSchema.parse(raw);
  const rows = selectedRows(snapshot, input);
  const groups = new Map<string, ExecutionRow[]>();
  for (const row of rows) {
    const key =
      input.group === "month" ? row.tradeDate.slice(0, 7) : row[input.group];
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const grouped = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, group]) => ({ id, ...summarizeExecution(group) }));
  const e = snapshot.execution;
  return {
    benchmark: e.benchmark,
    summary: summarizeExecution(rows),
    unitMismatchCount: rows.filter((r) => r.unitCheck.reason !== null).length,
    unitMismatches: e.unitMismatches.filter((m) =>
      rows.some((r) => r.fillIndex === m.fillIndex),
    ),
    loss: e.loss,
    terminalDifference: e.terminalDifference,
    fallbackNote: e.fallbackNote,
    counterfactualNonPositiveDays: e.counterfactualNonPositiveDays,
    counterfactualWorstNav: e.counterfactualWorstNav,
    // Loss always describes the whole account; detail filters never change replay.
    segments: e.segments,
    rowCount: rows.length,
    rows: rows.slice(
      input.pageIndex * input.pageSize,
      (input.pageIndex + 1) * input.pageSize,
    ),
    groupCount: grouped.length,
    groups: grouped.slice(
      input.groupPageIndex * 10,
      (input.groupPageIndex + 1) * 10,
    ),
  };
}
export function exportExecutionQuality(snapshot: Snapshot, raw: unknown) {
  const rows = selectedRows(snapshot, executionPageSchema.parse(raw));
  const header = [
    "日期",
    "代码",
    "名称",
    "方向",
    "成交价",
    "当日VWAP",
    "日均价偏差BP（正=不利）",
    "偏差金额折算（BP乘成交额）",
    "总费用",
    "成交额",
    "不可得原因",
    "基准口径",
    "原始VWAP",
    "单位比例",
    "倍率",
    "换算后VWAP",
    "换算后BP",
    "排除或不可得原因",
    "诊断类别",
    "诊断说明",
    "口径说明",
  ];
  // U4 §3.4: R2 redacts on import, not in exportTradeReview. Reuse redactRow
  // again for free text; export an allowlist, never account or raw ledger fields.
  const mapping = mapDeliveryColumns([]);
  const csv = [
    header,
    ...rows.map((r) =>
      [
        r.tradeDate,
        r.code,
        r.name ?? "",
        r.kind === "buy" ? "买入" : "卖出",
        r.price.value,
        r.vwap.value,
        r.slippageBp.value,
        r.slippageCost.value,
        r.fees.total.value,
        r.amount.value,
        r.slippageBp.reason ?? r.fees.total.reason ?? "",
        "dayVwap",
        r.unitCheck.rawVwap,
        r.unitCheck.ratio,
        r.unitCheck.factor,
        r.unitCheck.convertedVwap,
        r.unitCheck.convertedBp,
        r.unitCheck.reason ?? "",
        r.diagnostic.category,
        executionDiagnosticLabels[r.diagnostic.category],
        "全天VWAP事后描述；500BP阈值排除不证明单位错误；非实际节省费用",
      ].map((v) => (v === null ? "" : String(v))),
    ),
  ];
  return (
    "\uFEFF" +
    csv
      .map((row) =>
        redactRow(row, mapping)
          .map(
            (cell) =>
              `"${(/^[=+@-]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell) ? "'" + cell : cell).replaceAll('"', '""')}"`,
          )
          .join(","),
      )
      .join("\r\n")
  );
}
