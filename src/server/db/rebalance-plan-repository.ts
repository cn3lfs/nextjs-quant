import { z } from "zod";
import { sqlite } from "./index";

const idSchema = z.string().trim().min(1);
const timestampSchema = z.number().int().safe().nonnegative();
const dateSchema = z.string().date();
const positivePrice = z.number().finite().positive();
const accountSchema = z
  .object({
    accountScope: z.enum(["real", "paper"]),
    accountId: idSchema,
  })
  .strict();
const riskCheckSchema = z
  .object({
    code: idSchema,
    status: z.enum(["passed", "blocked", "unknown"]),
    symbol: idSchema.optional(),
    detail: z.string().optional(),
  })
  .strict();

const orderFields = z
  .object({
    symbol: idSchema,
    quantity: z.number().int().safe().positive(),
    riskChecks: z.array(riskCheckSchema),
  })
  .strict();

// Quantity is in shares. The ticket service resolves the instrument's lot rules.
export const rebalanceOrderSchema = z.discriminatedUnion("side", [
  orderFields.extend({
    side: z.literal("sell"),
    conditional: z.literal(false),
  }),
  orderFields.extend({
    side: z.literal("buy"),
    atrStopPrice: positivePrice,
    maxBuyPrice: positivePrice,
    conditional: z.boolean(),
  }),
]);
const ordersSchema = z
  .array(rebalanceOrderSchema)
  .superRefine((orders, ctx) => {
    let seenBuy = false;
    for (const [index, order] of orders.entries()) {
      if (order.side === "buy") seenBuy = true;
      else if (seenBuy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "调仓计划必须先卖后买",
          path: [index, "side"],
        });
      }
    }
  });

export const rebalanceRiskSummarySchema = z
  .object({
    status: z.enum(["normal", "reduced", "paused"]),
    checks: z.array(riskCheckSchema),
    metrics: z.record(z.number().finite().nullable()).optional(),
  })
  .strict();
export const rebalanceRecheckResultSchema = z
  .object({
    outcome: z.enum(["passed", "blocked", "conditional", "warning"]),
    checks: z.array(
      riskCheckSchema.extend({
        status: z.enum([...riskCheckSchema.shape.status.options, "warning"]),
      }),
    ),
  })
  .strict()
  .superRefine(({ outcome, checks }, ctx) => {
    const hasBlocked = checks.some(({ status }) => status === "blocked");
    let message: string;
    if (hasBlocked && outcome !== "blocked") {
      message = "存在阻断检查项时，复检结论必须为阻断";
    } else if (!hasBlocked && outcome === "blocked") {
      message = "复检结论为阻断时，至少需要一条阻断检查项";
    } else if (
      outcome === "passed" &&
      checks.some(({ status }) => status === "warning")
    ) {
      message = "存在警告检查项时，复检结论不能为通过";
    } else if (
      outcome === "passed" &&
      checks.some(({ status }) => status === "unknown")
    ) {
      message = "存在未确认检查项时，复检结论不能为通过";
    } else {
      return;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message });
  });

const planFields = accountSchema.extend({
  id: idSchema,
  sourceKind: z.enum(["alpha", "etf_rotation", "studio", "manual"]),
  sourceRefId: idSchema,
  asOfDate: dateSchema,
  executeDate: dateSchema,
  orders: ordersSchema,
  riskSummary: rebalanceRiskSummarySchema,
  expiresAt: timestampSchema,
});
function executesAfterClose({
  asOfDate,
  executeDate,
}: z.infer<typeof planFields>) {
  return executeDate > asOfDate;
}
const executionDateError = {
  message: "执行日必须晚于收盘决策日",
  path: ["executeDate"],
};
export const createRebalancePlanInputSchema = planFields.refine(
  executesAfterClose,
  executionDateError,
);
export const rebalancePlanRecordSchema = planFields
  .extend({
    status: z.enum(["draft", "confirmed", "rechecked", "expired", "cancelled"]),
    confirmedAt: timestampSchema.nullable(),
    recheckedAt: timestampSchema.nullable(),
    recheckResult: rebalanceRecheckResultSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine(executesAfterClose, executionDateError)
  .refine(
    (plan) => {
      const {
        status,
        createdAt,
        updatedAt,
        expiresAt,
        confirmedAt,
        recheckedAt,
        recheckResult,
      } = plan;
      if (createdAt >= expiresAt || updatedAt < createdAt) return false;
      if (status === "expired" ? updatedAt < expiresAt : updatedAt >= expiresAt)
        return false;
      if (
        confirmedAt !== null &&
        (confirmedAt < createdAt ||
          confirmedAt >= expiresAt ||
          confirmedAt > updatedAt)
      )
        return false;
      if ((recheckedAt === null) !== (recheckResult === null)) return false;
      if (
        recheckedAt !== null &&
        (confirmedAt === null ||
          recheckedAt < confirmedAt ||
          recheckedAt >= expiresAt ||
          recheckedAt > updatedAt)
      )
        return false;
      if (status === "draft") return confirmedAt === null;
      if (status === "confirmed")
        return confirmedAt !== null && recheckedAt === null;
      if (status === "rechecked") return recheckedAt !== null;
      return true;
    },
    { message: "调仓计划状态、时间与回执不一致" },
  );

export type RebalancePlanRecord = z.infer<typeof rebalancePlanRecordSchema>;
export type CreateRebalancePlanInput = z.input<
  typeof createRebalancePlanInputSchema
>;
export type RebalanceOrder = z.infer<typeof rebalanceOrderSchema>;
export type RebalanceRiskSummary = z.infer<typeof rebalanceRiskSummarySchema>;
export type RebalanceRecheckResult = z.infer<
  typeof rebalanceRecheckResultSchema
>;
export type RebalancePlanAccount = z.infer<typeof accountSchema>;

const cursorSchema = accountSchema.extend({
  executeDate: dateSchema,
  createdAt: timestampSchema,
  id: idSchema,
});
export type RebalancePlanCursor = z.infer<typeof cursorSchema>;
const pageSizeSchema = z.number().int().min(1).max(1000);

type PlanRow = Omit<
  RebalancePlanRecord,
  "orders" | "riskSummary" | "recheckResult"
> & {
  ordersJson: string;
  riskSummaryJson: string;
  recheckResultJson: string | null;
};
const columns = `id,account_scope AS accountScope,account_id AS accountId,
  source_kind AS sourceKind,source_ref_id AS sourceRefId,as_of_date AS asOfDate,
  execute_date AS executeDate,status,orders_json AS ordersJson,risk_summary_json AS riskSummaryJson,
  confirmed_at AS confirmedAt,rechecked_at AS recheckedAt,recheck_result_json AS recheckResultJson,
  expires_at AS expiresAt,created_at AS createdAt,updated_at AS updatedAt`;

function decodePlan({
  ordersJson,
  riskSummaryJson,
  recheckResultJson,
  ...row
}: PlanRow) {
  return rebalancePlanRecordSchema.parse({
    ...row,
    orders: JSON.parse(ordersJson),
    riskSummary: JSON.parse(riskSummaryJson),
    recheckResult:
      recheckResultJson === null ? null : JSON.parse(recheckResultJson),
  });
}

export function createRebalancePlan(
  raw: CreateRebalancePlanInput,
  now = Date.now(),
) {
  const input = createRebalancePlanInputSchema.parse(raw);
  const at = timestampSchema
    .lt(input.expiresAt, "过期时间必须晚于创建时间")
    .parse(now);
  const row = sqlite()
    .prepare(
      `
    INSERT INTO rebalance_plans (
      id,account_scope,account_id,source_kind,source_ref_id,as_of_date,execute_date,
      status,orders_json,risk_summary_json,expires_at,created_at,updated_at
    ) VALUES (@id,@accountScope,@accountId,@sourceKind,@sourceRefId,@asOfDate,@executeDate,
      'draft',@ordersJson,@riskSummaryJson,@expiresAt,@at,@at)
    RETURNING ${columns}
  `,
    )
    .get({
      ...input,
      ordersJson: JSON.stringify(input.orders),
      riskSummaryJson: JSON.stringify(input.riskSummary),
      at,
    }) as PlanRow;
  return decodePlan(row);
}

export function getRebalancePlan(id: string) {
  const key = idSchema.parse(id);
  const row = sqlite()
    .prepare(`SELECT ${columns} FROM rebalance_plans WHERE id=?`)
    .get(key) as PlanRow | undefined;
  return row ? decodePlan(row) : null;
}

export function listRebalancePlans(
  account: RebalancePlanAccount,
  limit: number,
  after?: RebalancePlanCursor,
) {
  const { accountScope, accountId } = accountSchema.parse(account);
  const size = pageSizeSchema.parse(limit);
  const cursor = cursorSchema.optional().parse(after);
  if (
    cursor &&
    (cursor.accountScope !== accountScope || cursor.accountId !== accountId)
  )
    throw new Error("调仓计划游标与账户不匹配");
  const rows = sqlite()
    .prepare(
      `
    SELECT ${columns} FROM rebalance_plans
    WHERE account_scope=? AND account_id=?
      ${cursor ? "AND (execute_date,created_at,id) < (?,?,?)" : ""}
    ORDER BY execute_date DESC,created_at DESC,id DESC LIMIT ?
  `,
    )
    .all(
      accountScope,
      accountId,
      ...(cursor ? [cursor.executeDate, cursor.createdAt, cursor.id] : []),
      size + 1,
    ) as PlanRow[];
  const items = rows.slice(0, size).map(decodePlan);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > size && last
        ? {
            accountScope,
            accountId,
            executeDate: last.executeDate,
            createdAt: last.createdAt,
            id: last.id,
          }
        : null,
  };
}

function requireTransition(row: PlanRow | undefined, action: string) {
  if (!row)
    throw new Error(
      `无法${action}调仓计划：计划不存在、已过期或当前状态及时间不允许该操作`,
    );
  return decodePlan(row);
}

/** The ticket service calls these writes for human confirmation and pre-open receipts. */
export function confirmRebalancePlan(id: string, now = Date.now()) {
  const key = idSchema.parse(id);
  const at = timestampSchema.parse(now);
  const row = sqlite()
    .prepare(
      `
    UPDATE rebalance_plans SET status='confirmed',confirmed_at=@at,updated_at=@at
    WHERE id=@id AND status='draft' AND updated_at<=@at AND expires_at>@at
    RETURNING ${columns}
  `,
    )
    .get({ id: key, at }) as PlanRow | undefined;
  return requireTransition(row, "确认");
}

export function recordRebalanceRecheck(
  id: string,
  raw: RebalanceRecheckResult,
  now = Date.now(),
) {
  const key = idSchema.parse(id);
  const resultJson = JSON.stringify(rebalanceRecheckResultSchema.parse(raw));
  const at = timestampSchema.parse(now);
  const row = sqlite()
    .prepare(
      `
    UPDATE rebalance_plans
    SET status='rechecked',rechecked_at=@at,recheck_result_json=@resultJson,updated_at=@at
    WHERE id=@id AND status='confirmed' AND updated_at<=@at AND expires_at>@at
    RETURNING ${columns}
  `,
    )
    .get({ id: key, at, resultJson }) as PlanRow | undefined;
  return requireTransition(row, "复检");
}

export function expireStaleRebalancePlans(now = Date.now()) {
  const at = timestampSchema.parse(now);
  return sqlite()
    .prepare(
      `
    UPDATE rebalance_plans SET status='expired',updated_at=@at
    WHERE status IN ('draft','confirmed','rechecked') AND expires_at<=@at
  `,
    )
    .run({ at }).changes;
}

export function cancelRebalancePlan(id: string, now = Date.now()) {
  const key = idSchema.parse(id);
  const at = timestampSchema.parse(now);
  const row = sqlite()
    .prepare(
      `
    UPDATE rebalance_plans SET status='cancelled',updated_at=@at
    WHERE id=@id AND status IN ('draft','confirmed','rechecked') AND updated_at<=@at AND expires_at>@at
    RETURNING ${columns}
  `,
    )
    .get({ id: key, at }) as PlanRow | undefined;
  return requireTransition(row, "取消");
}
