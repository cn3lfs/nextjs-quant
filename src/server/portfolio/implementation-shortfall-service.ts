import { z } from "zod";
import { classifySecurityCode } from "trading-strategy-core/security";
import {
  calculateImplementationShortfall,
  implementationShortfallInputSchema,
  shortfallFrozenPlanSchema,
  type ShortfallActualFill,
  type ShortfallMissing,
} from "~/lib/portfolio/implementation-shortfall";
import { type AccountBook } from "./account-workspace-service";
import { paperDailyBars } from "./account-workspace/daily-bars";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import {
  loadReadOnlyAccountBook,
  readAccountSourceBars,
} from "./portfolio-risk-service";

const accountQuerySchema = z
  .object({
    account: z.string().trim().min(1).max(200),
    scope: z.enum(["real", "paper"]).default("real"),
    from: z.string().date(),
    to: z.string().date(),
    /** All instructions with effects in this valuation window. IDs can be the
     * verified source plan/alert ID, or use explicit fillAssignments. */
    frozenPlan: shortfallFrozenPlanSchema.optional(),
    fillAssignments: z
      .record(z.string().min(1), z.string().min(1).nullable())
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.from > input.to)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "结束日期早于开始日期",
      });
    if (input.frozenPlan) {
      const parsed = implementationShortfallInputSchema.safeParse({
        ...input.frozenPlan,
        terminalDate: input.to,
        actual: [],
      });
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ ...issue, path: ["frozenPlan", ...issue.path] });
    } else if (input.fillAssignments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fillAssignments"],
        message: "成交归属需要对应冻结计划",
      });
    }
  });

export const implementationShortfallQuerySchema = z.union([
  z.object({ ledgers: implementationShortfallInputSchema }).strict(),
  accountQuerySchema,
]);
export type ImplementationShortfallQuery = z.input<
  typeof implementationShortfallQuerySchema
>;

async function accountShortfall(
  book: AccountBook,
  input: z.output<typeof accountQuerySchema>,
  at: number,
) {
  const { account, scope, from, to, frozenPlan } = input;
  const paper =
    scope === "paper"
      ? book.facts.paper.find((entry) => entry.account.id === account)
      : undefined;
  const delivery = new Map(
    book.facts.fills
      .filter((fill) => fill.account === account)
      .map((fill) => [`delivery:${fill.id}`, fill]),
  );
  const local = new Map(
    book.facts.local.map((fill) => [`local:${fill.id}`, fill]),
  );
  const paperFills = new Map(
    paper?.state?.result.fills.map((fill, index) => [
      `paper:${account}:${index}`,
      fill,
    ]),
  );
  const missing: ShortfallMissing[] = [];
  const eligiblePaper =
    paper?.account.market === "cn-equity" && paper.account.currency === "CNY";
  if (scope === "paper" && (!eligiblePaper || !paper.state))
    missing.push({
      field: "account",
      reason: "缺少已记账的人民币 A 股纸面账户",
    });
  if (
    scope === "real" &&
    !book.facts.batches.some((batch) => batch.account === account) &&
    !(account === "手工账本" && local.size)
  )
    missing.push({ field: "account", reason: "缺少选定的人民币真实账本" });
  if (!frozenPlan)
    missing.push({
      field: "frozenPlan",
      reason:
        "成交的策略来源关联不包含完整冻结指令、理论费用和次一合法到达基准",
    });
  const candidates = book.trades.filter(
    (trade) =>
      trade.kind === scope &&
      trade.account === account &&
      trade.market === "cn-equity" &&
      (scope !== "paper" || eligiblePaper) &&
      trade.date.slice(0, 10) >= from &&
      trade.date.slice(0, 10) <= to,
  );
  const planById = new Map(
    frozenPlan?.theoretical.map((plan) => [plan.id, plan]),
  );
  const plannedSides = new Set(
    frozenPlan?.theoretical.map((plan) => `${plan.symbol}:${plan.side}`),
  );
  const unusedAssignments = new Set(Object.keys(input.fillAssignments ?? {}));
  const actual: ShortfallActualFill[] = [];
  const sources = [];
  for (const trade of candidates) {
    const statement = delivery.get(trade.id);
    if (statement?.instrument === "reverseRepo") continue;
    sources.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      date: trade.date.slice(0, 10),
      strategyId: trade.strategyId,
      strategyVersion: trade.strategyVersion,
      planId: trade.planId,
      alertKey: trade.alertKey,
    });
    if (
      statement &&
      statement.instrument !== "stock" &&
      statement.instrument !== "fund"
    ) {
      missing.push({
        field: "quantityUnit",
        reason: "交割单证券的数量与期末估值单位须先核定",
        tradeId: trade.id,
        symbol: trade.symbol,
      });
      continue;
    }
    if (!Number.isSafeInteger(trade.quantity) || trade.quantity <= 0) {
      missing.push({
        field: "actualQuantity",
        reason: "实际成交缺少有效的整数股数",
        tradeId: trade.id,
        symbol: trade.symbol,
      });
      continue;
    }
    const validPlan = (id: string) => {
      const plan = planById.get(id);
      return plan?.symbol === trade.symbol && plan.side === trade.side;
    };
    const possible = [trade.planId, trade.alertKey].filter(
      (id): id is string => {
        return id !== null && validPlan(id);
      },
    );
    const verified = [...new Set(possible)];
    const override = input.fillAssignments;
    const instructionId =
      override && Object.hasOwn(override, trade.id)
        ? override[trade.id]
        : verified.length === 1
          ? verified[0]
          : frozenPlan && !plannedSides.has(`${trade.symbol}:${trade.side}`)
            ? null
            : undefined;
    unusedAssignments.delete(trade.id);
    if (instructionId != null && !validPlan(instructionId)) {
      missing.push({
        field: "fillAssignments",
        reason: "指定指令与实际成交的证券或方向不符，或指令不存在",
        tradeId: trade.id,
        instructionId,
        symbol: trade.symbol,
      });
      continue;
    }
    const simulation = paperFills.get(trade.id);
    const filledAt =
      trade.timePrecision === "instant" || (simulation?.date.length ?? 0) > 10
        ? trade.time
        : undefined;
    actual.push({
      id: trade.id,
      instructionId,
      symbol: trade.symbol,
      side: trade.side,
      date: trade.date.slice(0, 10),
      filledAt: Number.isFinite(filledAt) ? filledAt : undefined,
      fillPrice:
        Number.isFinite(trade.price) && trade.price > 0 ? trade.price : null,
      quantity: trade.quantity,
      fees:
        statement?.fees.total ??
        local.get(trade.id)?.fees.total ??
        simulation?.fee ??
        null,
    });
  }
  for (const tradeId of unusedAssignments)
    missing.push({
      field: "fillAssignments",
      reason: "指定成交不在本账户与区间的可归因成交内",
      tradeId,
    });
  const paperBars = scope === "paper" ? paperDailyBars(book, account) : {};
  const terminalPrices = { ...frozenPlan?.terminalPrices };
  const symbols = new Set([
    ...actual.map((fill) => fill.symbol),
    ...(frozenPlan?.theoretical.map((row) => row.symbol) ?? []),
  ]);
  const now = chinaClock(at);
  const completed = to < now.date || (to === now.date && now.time >= "15:05");
  const earliestSignalDate = (frozenPlan?.theoretical ?? []).reduce(
    (earliest, row) => {
      const signalDay = chinaClock(row.signalAt).date;
      return signalDay < earliest ? signalDay : earliest;
    },
    from,
  );
  // Include first-day and pre-window-signal corporate actions so a split on `from`
  // cannot leave decision, fill and terminal prices on mismatched share bases.
  const inActionWindow = (date: string) =>
    date >= earliestSignalDate && date <= to;
  const paperActionSymbols = new Set(
    paper?.state?.request.instruments
      .filter((instrument) =>
        instrument.actions?.some((action) => inActionWindow(action.date)),
      )
      .map((instrument) => instrument.symbol),
  );
  const actionGaps = new Map<string, ShortfallMissing>();
  for (const symbol of symbols) {
    // Frozen paper actions identify events. Their absence cannot establish
    // coverage, so both account scopes require a dated GBBQ source for stocks.
    const { coverageEnd, events } = book.context.evidence(symbol);
    if (
      classifySecurityCode(symbol.slice(2)).instrument === "stock" &&
      (!coverageEnd || coverageEnd < to)
    ) {
      actionGaps.set(symbol, {
        field: "corporateActionCoverage",
        reason: `GBBQ 公司行动覆盖截止日 ${coverageEnd ?? "未知"}，无法核验至估值结束日 ${to}`,
        symbol,
      });
    } else if (
      paperActionSymbols.has(symbol) ||
      events.some(
        (event) =>
          inActionWindow(event.date) && [1, 11, 12].includes(event.category),
      )
    ) {
      actionGaps.set(symbol, {
        field: "quantityUnit",
        reason:
          "区间有除权或股数变化，账户成交与期末估值须先换算为同一股份口径",
        symbol,
      });
    }
    // Local raw close at the exact valuation date. No previous close or fill-price fallback.
    if (Object.hasOwn(terminalPrices, symbol) || !completed) continue;
    const localMarks =
      book.bars[symbol]?.filter((bar) => bar.date === to) ?? [];
    const frozenMarks =
      paperBars[symbol]?.filter((bar) => bar.date === to) ?? [];
    const marks = localMarks.length
      ? localMarks
      : frozenMarks.length
        ? frozenMarks
        : !Object.hasOwn(book.bars, symbol) && book.config
          ? (await readAccountSourceBars(book.config.tdxRoot, symbol)).filter(
              (bar) => bar.date === to,
            )
          : [];
    if (
      marks.length === 1 &&
      Number.isFinite(marks[0]!.close) &&
      marks[0]!.close > 0
    )
      terminalPrices[symbol] = marks[0]!.close;
  }
  const report = calculateImplementationShortfall(
    {
      openingNav: frozenPlan?.openingNav,
      commonTerminalValue: frozenPlan?.commonTerminalValue,
      theoretical: frozenPlan?.theoretical ?? [],
      executable: frozenPlan?.executable ?? [],
      terminalDate: to,
      terminalPrices,
      actual,
    },
    [...missing, ...actionGaps.values()],
  );
  return {
    ...report,
    rows: report.rows.map((row) => {
      const gap = actionGaps.get(row.symbol);
      return gap
        ? {
            ...row,
            matchedQuantity: null,
            fills: row.fills.map((fill) => ({
              ...fill,
              matchedQuantity: null,
            })),
            reconciliation: null,
            missing: [...row.missing, gap],
          }
        : row;
    }),
    source: {
      kind: "account" as const,
      account,
      scope,
      from,
      to,
      trades: sources,
    },
  };
}

export async function readImplementationShortfall(
  value: ImplementationShortfallQuery,
  readBook: (at: number) => Promise<AccountBook> = loadReadOnlyAccountBook,
  at = Date.now(),
) {
  const input = implementationShortfallQuerySchema.parse(value);
  if ("ledgers" in input)
    return {
      ...calculateImplementationShortfall(input.ledgers),
      source: { kind: "explicit" as const },
    };
  return accountShortfall(await readBook(at), input, at);
}
