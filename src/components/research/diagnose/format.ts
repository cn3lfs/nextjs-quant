import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import {
  buildLabDraftFromHandoff,
  DIAGNOSE_CHECK_GROUPS,
  DIAGNOSE_CONDITIONAL_CHECK_GROUPS,
  type DiagnoseCheck,
  type DiagnoseCheckMetadata,
  type DiagnoseCheckStatus,
} from "~/lib/research/diagnose-contract";
import type { Tone } from "../../panels/tone";

export const formatCount = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : displayNumber(value, 0);

export const formatRatio = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? "—" : displayNumber(value, digits);

export const formatPercent = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined
    ? "—"
    : `${displayNumber(value * 100, digits)}%`;

export const formatSignedPercent = (
  value: number | null | undefined,
  digits = 2,
) => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return `${value > 0 ? "+" : ""}${displayNumber(value * 100, digits)}%`;
};

export const formatMoney = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export const formatMs = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : `${displayNumber(value, value < 10 ? 2 : 0)} ms`;

/** A-share price color: red up, green down; missing stays neutral. */
export function changeTone(value: number | null | undefined): Tone {
  return value === null || value === undefined || value === 0
    ? "idle"
    : value > 0
      ? "bad"
      : "ok";
}

export const checkStatusMeta: Record<
  DiagnoseCheckStatus,
  { label: string; tone: Tone }
> = {
  pass: { label: "通过", tone: "ok" },
  warn: { label: "告警", tone: "warn" },
  fail: { label: "失败", tone: "bad" },
  "not-evaluated": { label: "未评估", tone: "idle" },
  blocked: { label: "阻断", tone: "bad" },
};

export const checkGroupOrder: DiagnoseCheckMetadata["group"][] = [
  "数据与价格基",
  "信号与因果性",
  "撮合与费用",
  "账本与对账",
];

const metadataEntries: [string, DiagnoseCheckMetadata][] = [
  ...Object.entries(DIAGNOSE_CHECK_GROUPS),
  ...Object.entries(DIAGNOSE_CONDITIONAL_CHECK_GROUPS),
];

const metadataById = new Map<string, DiagnoseCheckMetadata>(metadataEntries);
const orderById = new Map<string, number>(
  metadataEntries.map(([id], index) => [id, index]),
);

export function checkMetadata(id: string): DiagnoseCheckMetadata | undefined {
  return metadataById.get(id);
}

export type GroupedChecks = {
  group: string;
  checks: DiagnoseCheck[];
};

/** Display order follows the contract, with unknown ids appended per group. */
export function groupChecks(checks: readonly DiagnoseCheck[]): GroupedChecks[] {
  const buckets = new Map<string, DiagnoseCheck[]>();
  for (const check of checks) {
    const group = checkMetadata(check.id)?.group ?? "其他检查";
    const rows = buckets.get(group) ?? [];
    rows.push(check);
    buckets.set(group, rows);
  }
  const groups = [...checkGroupOrder, "其他检查"]
    .filter((group) => buckets.has(group))
    .map((group) => ({
      group,
      checks: [...(buckets.get(group) ?? [])].sort(
        (a, b) =>
          (orderById.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (orderById.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id),
      ),
    }));
  return groups;
}

export function checkStatusCounts(checks: readonly DiagnoseCheck[]) {
  const counts: Record<DiagnoseCheckStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    "not-evaluated": 0,
    blocked: 0,
  };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

export type DiagnosticFocusTab = "fills" | "orders" | "rejections";
export type LedgerDiff = {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
};
export type DiagnosticFocusTarget = {
  date?: string;
  orderId?: number;
  tab?: DiagnosticFocusTab;
  signalDate?: boolean;
  ledgerDiff?: LedgerDiff;
};
const isoDate = /^\d{4}-\d{2}-\d{2}/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Evidence shapes differ per check, so focus targets are read defensively:
 * any ISO date and any numeric order id, bounded to avoid pathological input.
 */
export function extractEvidenceFocus(check: DiagnoseCheck) {
  const targets = new Map<string, DiagnosticFocusTarget>();
  const add = (target: DiagnosticFocusTarget) => {
    targets.set(JSON.stringify(target), target);
  };
  const dateOf = (value: unknown) =>
    typeof value === "string" && isoDate.test(value)
      ? value.slice(0, 10)
      : undefined;
  const orderIdOf = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  const isLedgerValue = (value: unknown): value is LedgerDiff["actual"] =>
    value === null || typeof value === "string" || typeof value === "number";
  const walk = (node: unknown, depth: number) => {
    if (depth > 5 || targets.size >= 15) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 8)) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    const date = dateOf(node.date);
    const signal = dateOf(node.signalAt ?? node.signalDate);
    const orderId = orderIdOf(node.orderId ?? node.id);
    if (
      check.id === "ledgerReconcile" &&
      date &&
      typeof node.field === "string" &&
      isLedgerValue(node.expected) &&
      isLedgerValue(node.actual)
    ) {
      const fillOrder = /^fills\.(\d+)\./.exec(node.field)?.[1];
      add({
        date,
        orderId:
          fillOrder === undefined ? undefined : orderIdOf(Number(fillOrder)),
        tab: "fills",
        ledgerDiff: {
          field: node.field,
          expected: node.expected,
          actual: node.actual,
        },
      });
      return;
    }
    if (signal) add({ date: signal, signalDate: true, tab: "orders" });
    if (date) add({ date, tab: "fills" });
    if (orderId !== undefined) add({ orderId, tab: "orders" });
    if (Array.isArray(node.orderIds)) {
      for (const value of node.orderIds.slice(0, 5)) {
        const id = orderIdOf(value);
        if (id !== undefined) add({ orderId: id, tab: "orders" });
      }
    }
    for (const child of Object.values(node).slice(0, 24))
      walk(child, depth + 1);
  };
  walk(check.evidence, 0);
  return [...targets.values()];
}

export const handoffSourceLabels = {
  formula: "公式选股",
  pattern: "形态筛选",
  rps: "RPS 排名",
  "account-review": "月度复盘",
} as const;

export const boundaryLabels = {
  ok: "正常",
  "zero-signal": "零信号",
  blocked: "阻断",
  "missing-files": "产物缺失",
} as const;

/** The draft produced by applying a /scan handoff to the Lab form. */
export type LabHandoffDraft = ReturnType<typeof buildLabDraftFromHandoff>;
