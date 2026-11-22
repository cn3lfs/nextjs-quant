import {
  prepareStrategy,
  validateStrategyBars,
  strategyObjectSchema,
  usesStrategyBook,
} from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { z } from "zod";
import type { PortfolioAction } from "quant-execution";
import { type PortfolioInstrument, type PortfolioRequest } from "./types.js";

const actionDate = z.union([
  z.string().date(),
  z.string().datetime({ offset: true }),
]);

function isActionDate(value: unknown): value is string {
  const parsed = actionDate.safeParse(value);
  return parsed.success && Number.isFinite(Date.parse(parsed.data));
}

export const keyFor = (strategy: string, symbol: string) =>
  JSON.stringify([strategy, symbol]);
export type PreparedInstrument = {
  instrument: PortfolioInstrument;
  indices: Map<string, number>;
  evaluators: Map<string, ReturnType<typeof prepareStrategy>>;
};
/** Owned by one immutable validation prefix; never shared across mutable calls. */
export function createPortfolioPreparation() {
  return new WeakMap<
    PortfolioInstrument,
    { signature: string; prepared: PreparedInstrument }
  >();
}

function invalidActionTiming(action: PortfolioAction) {
  const timing = action.timingAssumption as
    "ex-date-research-scenario" | "broker-ledger" | undefined;
  if (timing === "ex-date-research-scenario")
    return (
      !isActionDate(action.cashAvailableAt) ||
      (action.cashAvailableAt !== action.date &&
        action.cashAvailableAt !== action.date.slice(0, 10)) ||
      (action.sharesSellableAt !== undefined &&
        (!isActionDate(action.sharesSellableAt) ||
          Date.parse(action.sharesSellableAt) < Date.parse(action.date))) ||
      (action.bonus > 0 && !action.sharesSellableAt)
    );
  if (timing === "broker-ledger")
    return (
      (action.cashAvailableAt !== undefined &&
        (!isActionDate(action.cashAvailableAt) ||
          Date.parse(action.cashAvailableAt) < Date.parse(action.date))) ||
      (action.sharesSellableAt !== undefined &&
        (!isActionDate(action.sharesSellableAt) ||
          Date.parse(action.sharesSellableAt) < Date.parse(action.date)))
    );
  if (timing !== undefined || action.cashAvailableAt !== undefined) return true;
  if (
    action.sharesSellableAt !== undefined &&
    (!isActionDate(action.sharesSellableAt) ||
      Date.parse(action.sharesSellableAt) < Date.parse(action.date))
  )
    return true;
  return action.bonus > 0 && !action.sharesSellableAt;
}

export function preparePortfolioRequest(
  request: PortfolioRequest,
  preparation?: ReturnType<typeof createPortfolioPreparation>,
) {
  const { market, initial, sleeves } = request;
  if (
    !Number.isFinite(initial) ||
    initial <= 0 ||
    request.start > request.end ||
    !["cn-equity", "crypto"].includes(market)
  )
    throw new Error("Invalid portfolio request");
  const { maxParticipation, capacityPolicy } = request;
  if (
    maxParticipation !== undefined &&
    (!Number.isFinite(maxParticipation) ||
      maxParticipation <= 0 ||
      maxParticipation > 1)
  )
    throw new Error("Invalid maxParticipation");
  if (
    capacityPolicy !== undefined &&
    (maxParticipation === undefined ||
      !["clip", "reject"].includes(capacityPolicy))
  )
    throw new Error("Invalid capacityPolicy");
  if (
    !sleeves.length ||
    new Set(sleeves.map((s) => s.id)).size !== sleeves.length ||
    sleeves.some(
      (s) =>
        !s.id ||
        !Number.isFinite(s.share) ||
        s.share < 0 ||
        s.share > 1 ||
        !Number.isFinite(s.riskPerTrade) ||
        s.riskPerTrade <= 0 ||
        s.riskPerTrade > 1 ||
        !Number.isInteger(s.maxPositions) ||
        s.maxPositions < 1,
    ) ||
    Math.abs(sleeves.reduce((n, s) => n + s.share, 0) - 1) > 1e-10
  )
    throw new Error("Invalid sleeves");
  if (
    request.signalDelayBars !== undefined &&
    ![0, 1].includes(request.signalDelayBars)
  )
    throw new Error("Invalid signal delay");
  if (
    request.observationDetail !== undefined &&
    !["full", "counts"].includes(request.observationDetail)
  )
    throw new Error("Invalid observation detail");
  if (
    new Set(request.sleeveTargets?.map((t) => t.date)).size !==
      (request.sleeveTargets?.length ?? 0) ||
    request.sleeveTargets?.some(
      (t) =>
        t.availableAt > t.date ||
        !Number.isFinite(Date.parse(t.availableAt)) ||
        Object.keys(t.shares).length !== sleeves.length ||
        sleeves.some(
          (s) =>
            !Number.isFinite(t.shares[s.id]) ||
            t.shares[s.id]! < 0 ||
            t.shares[s.id]! > 1,
        ) ||
        Math.abs(sleeves.reduce((sum, s) => sum + t.shares[s.id]!, 0) - 1) >
          1e-10,
    )
  )
    throw new Error("Invalid / non-causal sleeve targets");
  if (
    request.rebalance &&
    ((request.rebalance.everyBars !== undefined &&
      (!Number.isInteger(request.rebalance.everyBars) ||
        request.rebalance.everyBars < 1)) ||
      (request.rebalance.drift !== undefined &&
        (!Number.isFinite(request.rebalance.drift) ||
          request.rebalance.drift <= 0 ||
          request.rebalance.drift > 1)))
  )
    throw new Error("Invalid rebalance policy");
  const costs = executionCostsSchema.parse(
    request.costs ?? marketRules[market].costs,
  );
  const strategies = request.strategies.map((s) =>
    strategyObjectSchema.parse(s),
  );
  const symbolUniverses = new Map(
    strategies.flatMap((s) =>
      s.universe.kind === "symbols"
        ? [[s.id, new Set(s.universe.symbols)] as const]
        : [],
    ),
  );
  if (
    !strategies.length ||
    new Set(strategies.map((s) => s.id)).size !== strategies.length ||
    strategies.some(
      (s) => s.market !== market || !sleeves.some((v) => v.id === s.sleeve),
    )
  )
    throw new Error("Invalid strategies / market / sleeve");
  if (
    !request.instruments.length ||
    new Set(request.instruments.map((i) => i.symbol)).size !==
      request.instruments.length ||
    request.instruments.some((i) => i.market !== market)
  )
    throw new Error("Invalid instruments");
  for (const row of request.memberships ?? [])
    if (
      !strategies.some((s) => s.id === row.strategyId) ||
      row.availableAt > row.date ||
      !Number.isFinite(Date.parse(row.availableAt)) ||
      new Set(row.symbols).size !== row.symbols.length
    )
      throw new Error("Invalid PIT universe membership");
  if (
    new Set((request.memberships ?? []).map((x) => `${x.strategyId}:${x.date}`))
      .size !== (request.memberships?.length ?? 0)
  )
    throw new Error("Duplicate PIT membership");
  const preparedSignature = JSON.stringify([strategies, request.end]);
  const instruments = new Map(
    request.instruments.map((instrument) => {
      const cached = preparation?.get(instrument);
      if (cached?.signature === preparedSignature)
        return [instrument.symbol, cached.prepared] as const;
      validateStrategyBars(instrument.bars);
      if (
        instrument.bars.length !== instrument.signalBars.length ||
        instrument.bars.some(
          (b, i) => b.date !== instrument.signalBars[i]!.date,
        )
      )
        throw new Error("Raw / signal alignment mismatch");
      const actions = instrument.actions ?? [];
      if (
        instrument.terminal &&
        (!instrument.terminal.evidence.trim() ||
          !["last-close", "total-loss"].includes(
            instrument.terminal.valuation,
          ) ||
          !Number.isFinite(Date.parse(instrument.terminal.date)) ||
          (instrument.terminal.date <= request.end &&
            instrument.bars.at(-1)?.date !== instrument.terminal.date))
      )
        throw new Error("Invalid terminal sensitivity evidence/date");
      if (
        new Set(actions.map((a) => a.date)).size !== actions.length ||
        actions.some(
          (a) =>
            !a.evidence ||
            Date.parse(a.availableAt) > Date.parse(a.date) ||
            !Number.isFinite(a.dividend) ||
            a.dividend < 0 ||
            !Number.isFinite(a.bonus) ||
            a.bonus < 0 ||
            !Number.isFinite(Date.parse(a.date)) ||
            !Number.isFinite(Date.parse(a.availableAt)) ||
            (a.shareFactor !== undefined &&
              (!Number.isFinite(a.shareFactor) || a.shareFactor <= 0)) ||
            (a.rightsRatio !== undefined &&
              (!Number.isFinite(a.rightsRatio) || a.rightsRatio < 0)) ||
            ((a.rightsRatio ?? 0) > 0 &&
              (a.rightsPrice === undefined ||
                !Number.isFinite(a.rightsPrice) ||
                a.rightsPrice < 0)) ||
            invalidActionTiming(a),
        )
      )
        throw new Error("Unsupported / unproven corporate action");
      const prepared: PreparedInstrument = {
        instrument,
        indices: new Map(instrument.bars.map((b, i) => [b.date, i])),
        evaluators: new Map(
          strategies.map((s) => [
            s.id,
            prepareStrategy(s, instrument.signalBars, instrument.external),
          ]),
        ),
      };
      preparation?.set(instrument, { signature: preparedSignature, prepared });
      return [instrument.symbol, prepared] as const;
    }),
  );
  const weightRows = new Map<
    string,
    NonNullable<PortfolioRequest["positionWeights"]>[number][]
  >();
  for (const row of request.positionWeights ?? []) {
    if (
      !strategies.some((s) => s.id === row.strategyId) ||
      !instruments.has(row.symbol) ||
      !Number.isFinite(row.weight) ||
      row.weight < 0 ||
      row.weight > 1 ||
      !Number.isFinite(Date.parse(row.date)) ||
      !Number.isFinite(Date.parse(row.availableAt)) ||
      row.availableAt > row.date
    )
      throw new Error("Invalid causal position weight");
    const key = keyFor(row.strategyId, row.symbol);
    const rows = weightRows.get(key) ?? [];
    if (rows.some((r) => r.date === row.date))
      throw new Error("Duplicate position weight");
    rows.push(row);
    weightRows.set(key, rows);
  }
  for (const rows of weightRows.values())
    rows.sort((a, b) => a.date.localeCompare(b.date));
  const scheduledAt = new Map<
    string,
    NonNullable<PortfolioRequest["scheduledTargets"]>[number][]
  >();
  const scheduledKeys = new Set<string>();
  for (const row of request.scheduledTargets ?? []) {
    const strategy = strategies.find((s) => s.id === row.strategyId);
    if (
      !strategy ||
      strategy.period !== "day" ||
      strategy.universe.kind !== "symbols" ||
      strategy.entry.kind !== "constant" ||
      strategy.entry.value ||
      (strategy.exit.rule &&
        (strategy.exit.rule.kind !== "constant" || strategy.exit.rule.value)) ||
      usesStrategyBook(strategy) ||
      Object.keys(strategy.exit).some((key) => key !== "rule") ||
      request.positionWeights?.some(
        (weight) => weight.strategyId === strategy.id,
      )
    )
      throw new Error(
        "Scheduled targets require an exclusive constant-false daily strategy",
      );
    if (
      !Number.isFinite(Date.parse(row.date)) ||
      !Number.isFinite(Date.parse(row.availableAt)) ||
      Date.parse(row.availableAt) > Date.parse(row.date) ||
      !request.calendar.includes(row.date) ||
      typeof row.sourceHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(row.sourceHash) ||
      !row.targets ||
      typeof row.targets !== "object" ||
      Array.isArray(row.targets) ||
      (row.scores !== undefined &&
        (!row.scores ||
          typeof row.scores !== "object" ||
          Array.isArray(row.scores)))
    )
      throw new Error("Invalid / non-causal scheduled target evidence");
    const weights = Object.entries(row.targets);
    const universe = symbolUniverses.get(strategy.id)!;
    if (
      weights.some(
        ([symbol, weight]) =>
          !instruments.has(symbol) ||
          !universe.has(symbol) ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 1,
      ) ||
      Object.entries(row.scores ?? {}).some(
        ([symbol, score]) =>
          !Object.hasOwn(row.targets, symbol) || !Number.isFinite(score),
      ) ||
      weights.reduce((sum, [, weight]) => sum + weight, 0) > 1 + 1e-10
    )
      throw new Error("Invalid scheduled target symbols / weights");
    const key = `${row.strategyId}:${row.date}`;
    if (scheduledKeys.has(key)) throw new Error("Duplicate scheduled target");
    scheduledKeys.add(key);
    const rows = scheduledAt.get(row.date) ?? [];
    rows.push(row);
    scheduledAt.set(row.date, rows);
  }

  return {
    costs,
    strategies,
    instruments,
    symbolUniverses,
    weightRows,
    scheduledAt,
  };
}
