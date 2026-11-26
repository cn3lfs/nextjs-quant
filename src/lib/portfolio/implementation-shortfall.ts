import { big } from "trading-strategy-core/money";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { z } from "zod";

const id = z.string().trim().min(1).max(500);
const date = z.string().date();
const time = z.number().int().nonnegative().max(8e15);
const price = z.number().finite().positive().nullish();
const quantity = z.number().int().safe().nonnegative();
const fees = z.number().finite().nullish();
const side = z.enum(["buy", "sell"]);
const instrument = z.object({ symbol: symbolSchema, side });

const theoretical = instrument
  .extend({
    id,
    signalAt: time,
    decisionPrice: price,
    quantity,
    fees,
  })
  .strict();
const executable = z
  .object({
    instructionId: id,
    arrivalAt: time.nullish(),
    arrivalPrice: price,
    quantity,
    fees,
  })
  .strict();
const actual = instrument
  .extend({
    id,
    /** Null confirms a plan deviation. Omission means the linkage is unknown. */
    instructionId: id.nullable().optional(),
    date,
    filledAt: time.nullish(),
    fillPrice: price,
    quantity: quantity.positive(),
    /** Booked separately from both the execution price and venue fees. */
    slippageCharge: z.number().finite().nonnegative().optional(),
    fees,
  })
  .strict();

export const shortfallFrozenPlanSchema = z
  .object({
    currency: z.literal("CNY").default("CNY"),
    openingNav: z.number().finite().nonnegative().nullish(),
    /** Terminal value of the common opening inventory/cash and common changes,
     * before the incremental effects of these orders. For an all-cash book
     * without flows, this is the opening NAV. */
    commonTerminalValue: z.number().finite().nullish(),
    theoretical: z.array(theoretical),
    executable: z.array(executable),
    terminalPrices: z.record(symbolSchema, price).default({}),
  })
  .strict();

export const implementationShortfallInputSchema = shortfallFrozenPlanSchema
  .extend({
    terminalDate: date,
    actual: z.array(actual),
  })
  .strict()
  .superRefine((input, ctx) => {
    const end = Date.parse(`${input.terminalDate}T23:59:59.999+08:00`);
    const invalid = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const instructions = new Map<string, ShortfallTheoreticalInstruction>();
    const executableIds = new Set<string>();
    const fillIds = new Set<string>();
    for (const [i, row] of input.theoretical.entries()) {
      if (instructions.has(row.id))
        invalid(["theoretical", i, "id"], "理论指令编号重复");
      if (row.signalAt > end)
        invalid(["theoretical", i, "signalAt"], "信号晚于估值日");
      instructions.set(row.id, row);
    }
    for (const [i, row] of input.executable.entries()) {
      const plan = instructions.get(row.instructionId);
      if (executableIds.has(row.instructionId) || !plan)
        invalid(
          ["executable", i, "instructionId"],
          "基线指令重复或缺少对应理论指令",
        );
      if (plan && row.quantity > plan.quantity)
        invalid(["executable", i, "quantity"], "可执行股数超过理论股数");
      if (plan && row.arrivalAt != null && row.arrivalAt < plan.signalAt)
        invalid(["executable", i, "arrivalAt"], "到达时间早于信号");
      if (row.quantity > 0 && row.arrivalAt != null && row.arrivalAt > end)
        invalid(["executable", i, "arrivalAt"], "可执行指令到达晚于估值日");
      executableIds.add(row.instructionId);
    }
    for (const [i, fill] of input.actual.entries()) {
      if (fillIds.has(fill.id))
        invalid(["actual", i, "id"], "实际成交编号重复");
      if (
        fill.date > input.terminalDate ||
        (fill.filledAt != null && chinaDate(fill.filledAt) !== fill.date)
      )
        invalid(["actual", i, "date"], "成交日期与时间或估值日不一致");
      if (fill.instructionId != null) {
        const plan = instructions.get(fill.instructionId);
        if (!plan || plan.symbol !== fill.symbol || plan.side !== fill.side)
          invalid(
            ["actual", i, "instructionId"],
            "实际成交与理论指令的编号、证券或方向不符",
          );
      }
      fillIds.add(fill.id);
    }
  });

export type ShortfallTheoreticalInstruction = z.infer<typeof theoretical>;
export type ShortfallExecutableInstruction = z.infer<typeof executable>;
export type ShortfallActualFill = z.infer<typeof actual>;
export type ShortfallFrozenPlan = z.input<typeof shortfallFrozenPlanSchema>;
export type ImplementationShortfallInput = z.input<
  typeof implementationShortfallInputSchema
>;
export type ShortfallMissing = {
  field: string;
  reason: string;
  instructionId?: string;
  tradeId?: string;
  symbol?: string;
};
type Decimal = ReturnType<typeof big>;
const chinaDate = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const sum = (values: readonly Decimal[]) =>
  values.reduce((a, b) => a.plus(b), big(0));
const sign = (side: "buy" | "sell") => (side === "buy" ? 1 : -1);

export const shortfallComponentKeys = [
  "signalToArrivalDelay",
  "arrivalToFillSlippage",
  "missedTradeOpportunityCost",
  "behaviorDeviation",
  "feeDifference",
] as const;
type Component = (typeof shortfallComponentKeys)[number];
type Amount = { cny: number; bps: number | null };
type Amounts = Record<Component, Amount> & { totalShortfall: Amount };
type DecimalAmounts = Record<Component, Decimal>;
type Values = {
  theoreticalTerminalValue: Decimal;
  executableTerminalValue: Decimal;
  actualTerminalValue: Decimal;
};

function publish(
  amounts: DecimalAmounts,
  values: Values,
  base: Decimal | null,
) {
  const total = sum(shortfallComponentKeys.map((key) => amounts[key]));
  const terminalDiff = values.actualTerminalValue.minus(
    values.theoreticalTerminalValue,
  );
  if (!terminalDiff.plus(total).eq(0))
    throw new Error("实施缺口金额恒等式失衡");
  const amount = (value: Decimal): Amount => ({
    cny: value.toNumber(),
    bps: base?.gt(0) ? value.times(10000).div(base).toNumber() : null,
  });
  const result = {
    theoreticalTerminalValue: values.theoreticalTerminalValue.toNumber(),
    executableTerminalValue: values.executableTerminalValue.toNumber(),
    actualTerminalValue: values.actualTerminalValue.toNumber(),
    terminalDiff: terminalDiff.toNumber(),
    amounts: {
      signalToArrivalDelay: amount(amounts.signalToArrivalDelay),
      arrivalToFillSlippage: amount(amounts.arrivalToFillSlippage),
      missedTradeOpportunityCost: amount(amounts.missedTradeOpportunityCost),
      behaviorDeviation: amount(amounts.behaviorDeviation),
      feeDifference: amount(amounts.feeDifference),
      totalShortfall: amount(total),
    } satisfies Amounts,
  };
  const components = shortfallComponentKeys.map(
    (key) => result.amounts[key].cny,
  );
  const signedDiff =
    result.actualTerminalValue - result.theoreticalTerminalValue;
  return [
    result.theoreticalTerminalValue,
    result.executableTerminalValue,
    result.actualTerminalValue,
    result.terminalDiff,
  ].every(Number.isFinite) &&
    Object.values(result.amounts).every(
      ({ cny, bps }) =>
        Number.isFinite(cny) && (bps === null || Number.isFinite(bps)),
    ) &&
    Math.abs(signedDiff - result.terminalDiff) <= 1e-6 &&
    Math.abs(signedDiff + components.reduce((total, cny) => total + cny, 0)) <=
      1e-6
    ? result
    : null;
}

function terminalContribution(
  side: "buy" | "sell",
  qty: number,
  px: number,
  mark: number,
  fee: number,
) {
  return big(mark).minus(px).times(qty).times(sign(side)).minus(fee);
}

export type ShortfallRow = {
  instructionId: string | null;
  symbol: string;
  side: "buy" | "sell";
  theoreticalQuantity: number;
  executableQuantity: number | null;
  matchedQuantity: number | null;
  fills: {
    tradeId: string;
    actualQuantity: number;
    matchedQuantity: number | null;
  }[];
  nominalCny: number | null;
  /** Each row contributes only its incremental cash and marked inventory. */
  reconciliation: ReturnType<typeof publish> | null;
  missing: ShortfallMissing[];
};

function analyzeRow(
  input: z.output<typeof implementationShortfallInputSchema>,
  plan: ShortfallTheoreticalInstruction | null,
  baseline: ShortfallExecutableInstruction | undefined,
  fills: ShortfallActualFill[],
  pendingFills: ShortfallActualFill[] = [],
) {
  const { symbol, side } = plan ?? fills[0]!;
  const missing: ShortfallMissing[] = [];
  const miss = (field: string, reason: string, tradeId?: string) =>
    missing.push({
      field,
      reason,
      symbol,
      ...(plan && { instructionId: plan.id }),
      ...(tradeId && { tradeId }),
    });
  const plannedQty = plan?.quantity ?? 0;
  const executableQty = plan ? (baseline?.quantity ?? null) : 0;
  const terminalPrice = Object.hasOwn(input.terminalPrices, symbol)
    ? input.terminalPrices[symbol]
    : undefined;
  if ((plannedQty || fills.length) && terminalPrice == null)
    miss("terminalPrice", `缺少 ${input.terminalDate} 期末估值`);
  if (plan) {
    if (plannedQty > 0 && plan.decisionPrice == null)
      miss("decisionPrice", "缺少策略信号基准价");
    if (plan.fees == null) miss("theoreticalFees", "缺少理论费用");
    if (!baseline)
      miss("executable", "缺少冻结可执行指令，无法确认规则裁剪与到达基准");
    else {
      if (baseline.fees == null) miss("executableFees", "缺少可执行基线费用");
      if (baseline.quantity > 0 && baseline.arrivalPrice == null)
        miss("arrivalPrice", "缺少可执行到达基准价");
      if (baseline.quantity > 0 && baseline.arrivalAt == null)
        miss("arrivalAt", "缺少可执行到达时间");
    }
  }
  const arrival = baseline?.arrivalAt ?? null;
  const arrivalDate = arrival === null ? null : chinaDate(arrival);
  const fillsByDate = new Map<string, ShortfallActualFill[]>();
  for (const fill of [...fills, ...pendingFills]) {
    const group = fillsByDate.get(fill.date) ?? [];
    group.push(fill);
    fillsByDate.set(fill.date, group);
  }
  let remaining = executableQty;
  const allocations: ShortfallRow["fills"] = [];
  for (const day of [...fillsByDate.keys()].sort()) {
    const dayFills = fillsByDate.get(day)!;
    const onArrivalDay = day === arrivalDate;
    const afterArrivalDay = arrivalDate !== null && day > arrivalDate;
    // Decide whether the whole day can be allocated before any fill uses its
    // quota. On later days order matters only when candidates vie for shares.
    if (remaining) {
      if (arrivalDate === null) remaining = null;
      else if (onArrivalDay || afterArrivalDay) {
        const untimed = dayFills.filter((fill) => fill.filledAt == null);
        const competesForShares =
          dayFills.length > 1 &&
          dayFills.reduce((total, fill) => total + fill.quantity, 0) >
            remaining;
        if (untimed.length && (onArrivalDay || competesForShares)) {
          const reason = onArrivalDay
            ? "成交与指令到达同日，缺少执行时刻，无法确认先后与匹配股数"
            : "同日成交竞争剩余可执行股数，缺少执行时刻，无法确认分配顺序";
          for (const fill of untimed) miss("filledAt", reason, fill.id);
          remaining = null;
        }
      }
    }
    for (const fill of dayFills) {
      if (fill.instructionId === undefined) {
        // Pending linkage can block timing for this plan. The fill is still
        // reported only once, in its own unassigned row.
        if (plan) continue;
        miss("instructionId", "成交是否对应冻结理论指令无法确认", fill.id);
      }
      if (fill.fillPrice == null) miss("fillPrice", "缺少实际成交价", fill.id);
      if (fill.fees == null) miss("actualFees", "缺少实际成交费用", fill.id);
      const eligible =
        afterArrivalDay ||
        (arrival !== null && fill.filledAt != null && fill.filledAt >= arrival);
      const matched =
        remaining === null || fill.instructionId === undefined
          ? null
          : eligible
            ? Math.min(remaining, fill.quantity)
            : 0;
      if (remaining !== null && matched !== null) remaining -= matched;
      allocations.push({
        tradeId: fill.id,
        actualQuantity: fill.quantity,
        matchedQuantity: matched,
      });
    }
  }
  const matchedQuantity =
    remaining === null ||
    allocations.some((fill) => fill.matchedQuantity === null)
      ? null
      : executableQty! - remaining;
  const nominal = plan
    ? plan.decisionPrice == null
      ? null
      : big(plan.decisionPrice).times(plannedQty)
    : fills[0]!.fillPrice == null
      ? null
      : big(fills[0]!.fillPrice!).times(fills[0]!.quantity);
  let detail: { amounts: DecimalAmounts; values: Values } | null = null;
  if (!missing.length) {
    // The decimal equations below use a neutral zero only for a proven zero-quantity leg.
    const mark = terminalPrice ?? 0;
    const decision = plan?.decisionPrice ?? 0;
    const arrival = baseline?.arrivalPrice ?? 0;
    const step = (from: number, to: number, qty: number) =>
      big(to).minus(from).times(qty).times(sign(side));
    const actualFees = sum(fills.map((fill) => big(fill.fees!)));
    const charges = fills.map((fill) => big(fill.slippageCharge ?? 0));
    const matchedCharges = fills.map((fill, i) =>
      charges[i]!.times(allocations[i]!.matchedQuantity!).div(fill.quantity),
    );
    // Positive means a worse result for actual: buy higher, sell lower.
    // Only matched shares enter delay/slippage, missed legal and clipped shares
    // both use the decision-to-terminal move, and unmatched actual shares enter behavior.
    const amounts: DecimalAmounts = {
      signalToArrivalDelay: step(decision, arrival, matchedQuantity!),
      arrivalToFillSlippage: sum(
        fills.map((fill, i) =>
          step(arrival, fill.fillPrice!, allocations[i]!.matchedQuantity!).plus(
            matchedCharges[i]!,
          ),
        ),
      ),
      missedTradeOpportunityCost: step(
        decision,
        mark,
        executableQty! - matchedQuantity!,
      ).plus(step(decision, mark, plannedQty - executableQty!)),
      behaviorDeviation: sum(
        fills.map((fill, i) =>
          step(
            mark,
            fill.fillPrice!,
            fill.quantity - allocations[i]!.matchedQuantity!,
          )
            .plus(charges[i]!)
            .minus(matchedCharges[i]!),
        ),
      ),
      feeDifference: actualFees.minus(plan?.fees ?? 0),
    };
    const values: Values = {
      theoreticalTerminalValue: terminalContribution(
        side,
        plannedQty,
        decision,
        mark,
        plan?.fees ?? 0,
      ),
      executableTerminalValue: terminalContribution(
        side,
        executableQty!,
        arrival,
        mark,
        baseline?.fees ?? 0,
      ),
      actualTerminalValue: sum(
        fills.map((fill, i) =>
          terminalContribution(
            side,
            fill.quantity,
            fill.fillPrice!,
            mark,
            fill.fees!,
          ).minus(charges[i]!),
        ),
      ),
    };
    detail = { values, amounts };
  }
  const reconciliation =
    detail && publish(detail.amounts, detail.values, nominal);
  if (detail && !reconciliation)
    miss("numericPrecision", "金额超出接口可精确对平的数值范围");
  const nominalCny = nominal?.toNumber();
  const row: ShortfallRow = {
    instructionId: plan?.id ?? null,
    symbol,
    side,
    theoreticalQuantity: plannedQty,
    executableQuantity: executableQty,
    matchedQuantity,
    fills: allocations,
    nominalCny:
      nominalCny !== undefined && Number.isFinite(nominalCny)
        ? nominalCny
        : null,
    reconciliation,
    missing,
  };
  return { row, detail };
}

export function calculateImplementationShortfall(
  value: ImplementationShortfallInput,
  sourceMissing: readonly ShortfallMissing[] = [],
) {
  const input = implementationShortfallInputSchema.parse(value);
  const baseline = new Map(
    input.executable.map((row) => [row.instructionId, row]),
  );
  const fillsByInstruction = new Map<string, ShortfallActualFill[]>();
  const pendingByInstrument = new Map<string, ShortfallActualFill[]>();
  const otherFills: ShortfallActualFill[] = [];
  const sorted = [...input.actual].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.filledAt ?? Infinity) - (b.filledAt ?? Infinity),
  );
  for (const fill of sorted) {
    if (fill.instructionId == null) {
      otherFills.push(fill);
      if (fill.instructionId === undefined) {
        const key = `${fill.symbol}:${fill.side}`;
        const group = pendingByInstrument.get(key) ?? [];
        group.push(fill);
        pendingByInstrument.set(key, group);
      }
    } else {
      const group = fillsByInstruction.get(fill.instructionId) ?? [];
      group.push(fill);
      fillsByInstruction.set(fill.instructionId, group);
    }
  }
  const analyzed = [
    ...input.theoretical.map((plan) =>
      analyzeRow(
        input,
        plan,
        baseline.get(plan.id),
        fillsByInstruction.get(plan.id) ?? [],
        pendingByInstrument.get(`${plan.symbol}:${plan.side}`),
      ),
    ),
    ...otherFills.map((fill) => analyzeRow(input, null, undefined, [fill])),
  ];
  const rows = analyzed.map(({ row }) => row);
  const missing = [...sourceMissing, ...rows.flatMap((row) => row.missing)];
  if (input.openingNav == null)
    missing.push({
      field: "openingNav",
      reason: "缺少理论期初净值，无法计算汇总 bps",
    });
  if (input.commonTerminalValue == null)
    missing.push({
      field: "commonTerminalValue",
      reason: "缺少共同期末价值基数，无法计算三账期末净值",
    });
  const fills = rows.flatMap((row) => row.fills);
  const knownAllocation =
    sourceMissing.length === 0 &&
    fills.every((fill) => fill.matchedQuantity !== null);
  const matched = fills.reduce((n, fill) => n + (fill.matchedQuantity ?? 0), 0);
  const actualQty = fills.reduce((n, fill) => n + fill.actualQuantity, 0);
  const executableQty = rows.every((row) => row.executableQuantity !== null)
    ? rows.reduce((n, row) => n + row.executableQuantity!, 0)
    : null;
  let reconciliation = null;
  if (!missing.length) {
    const details = analyzed.map(({ detail }) => detail!);
    const amounts = Object.fromEntries(
      shortfallComponentKeys.map((key) => [
        key,
        sum(details.map((d) => d.amounts[key])),
      ]),
    ) as DecimalAmounts;
    const terminal = (key: keyof Values) =>
      sum(details.map((d) => d.values[key])).plus(input.commonTerminalValue!);
    reconciliation = publish(
      amounts,
      {
        theoreticalTerminalValue: terminal("theoreticalTerminalValue"),
        executableTerminalValue: terminal("executableTerminalValue"),
        actualTerminalValue: terminal("actualTerminalValue"),
      },
      big(input.openingNav!),
    );
    if (!reconciliation)
      missing.push({
        field: "numericPrecision",
        reason: "汇总金额超出接口可精确对平的数值范围",
      });
  }
  const status = missing.length ? "incomplete" : "complete";
  return {
    status,
    currency: "CNY" as const,
    terminalDate: input.terminalDate,
    openingNav: input.openingNav ?? null,
    reconciliation,
    rows,
    missing,
    // Share-weighted. Mandatory rule clipping is outside the missed-trade rate.
    disciplineAdherenceRate:
      knownAllocation && actualQty > 0 ? matched / actualQty : null,
    missedTradeRate:
      knownAllocation && executableQty !== null && executableQty > 0
        ? (executableQty - matched) / executableQty
        : null,
    unplannedFillCount: knownAllocation
      ? fills.filter((fill) => fill.matchedQuantity! < fill.actualQuantity)
          .length
      : null,
  } as const;
}

export type ImplementationShortfallReport = ReturnType<
  typeof calculateImplementationShortfall
>;
