import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import {
  defaultPortfolioRiskPolicy,
  resolveInstrumentRule,
} from "quant-execution";
import { isTerminalIntentStatus } from "trading-strategies";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import { big } from "trading-strategy-core/money";
import type { DeploymentRecord } from "../db/deployment-repository";
import {
  appendExecutionAuditEvent,
  getPipelineRun,
  type OrderIntentRecord,
} from "../db/pipeline-repository";
import { normalizePoolSymbol } from "../db/pool-repository";
import { SimAccountRepository } from "../db/sim-account-repository";
import { arrivalEvidence } from "../execution/pipeline-proceeds";
import {
  quoteTimeError,
  type PipelineQuoteReader,
} from "../execution/pipeline-quote-provider";
import {
  VenueAccountConfigError,
  type ExecutionVenueAdapter,
} from "../execution/venue-router";
import {
  moneyDigits,
  normalizeSimSymbol,
  quantityDigits,
  replayPositions,
} from "../portfolio/sim-accounts/engine";
import { decisionIndustries, readPlanningFacts } from "./account-coordinator";
import type { PipelineAccountState } from "./signal-risk-runner";

type Db = Database.Database;
type ExposureState = Pick<
  PipelineAccountState,
  "cash" | "equity" | "positions"
>;
const positive = (price: number | null | undefined): price is number =>
  typeof price === "number" && Number.isFinite(price) && price > 0;

function accountFacts(
  i: OrderIntentRecord,
  deployment: DeploymentRecord,
  db: Db,
) {
  const { commitments, accountCaps, revision } = readPlanningFacts(
    { ...deployment, venueBinding: i.venueBinding },
    i.executeDate,
    i.executeDate,
    db,
    Date.now(),
    [], // Execution uses the physical book; sleeve ownership is a planning input.
  );
  return {
    commitments: commitments.filter((order) => order.id !== i.id),
    accountCaps,
    revision,
  };
}

export async function readExecutionRiskSnapshot(
  i: OrderIntentRecord,
  deployment: DeploymentRecord,
  executePrice: number,
  reader: PipelineQuoteReader,
  adapter: ExecutionVenueAdapter,
  now: () => number,
  db: Db,
) {
  const facts = accountFacts(i, deployment, db);
  let state: ExposureState | null = null;
  let failure = "execution-risk-evidence-missing";
  try {
    if (i.venueBinding.kind !== "local_sim") {
      state = await adapter.readAccountState(i.venueBinding, i.executeDate, db);
    } else {
      const id = i.venueBinding.simAccountId;
      const repo = new SimAccountRepository(db);
      const { market, cash_atoms } = repo.account(id);
      const book = replayPositions(repo.fills(id), market, i.executeDate);
      const cash = big(cash_atoms.toString()).div(
        big(10).pow(moneyDigits(market)),
      );
      const positions = await Promise.all(
        Array.from(book, async ([raw, lot]) => {
          const symbol = normalizePoolSymbol(raw);
          let lastPrice: number | null = executePrice;
          if (raw !== normalizeSimSymbol(i.symbol, market)) {
            const quote = reader.readChecked
              ? await reader.readChecked(symbol, i.executeDate)
              : await reader(symbol, i.executeDate);
            lastPrice =
              quote &&
              normalizePoolSymbol(quote.symbol) === symbol &&
              !quoteTimeError(quote, i.executeDate, now(), true)
                ? (quote.lastPrice ?? quote.openPrice)
                : null;
          }
          const scale = big(10).pow(quantityDigits(market));
          return {
            symbol,
            lastPrice,
            quantity: big(lot.quantity.toString()).div(scale).toNumber(),
            sellable: big(lot.sellable.toString()).div(scale).toNumber(),
          };
        }),
      );
      const equity = positions.every((p) => positive(p.lastPrice))
        ? positions
            .reduce(
              (sum, p) => sum.plus(big(p.quantity).times(p.lastPrice!)),
              cash,
            )
            .toNumber()
        : NaN;
      state = { cash: cash.toNumber(), equity, positions };
    }
  } catch (error) {
    if (error instanceof VenueAccountConfigError) failure = error.message;
  }
  return { facts, state, failure };
}

/** Recheck the positions snapshot and all other account commitments under the claim lock. */
export function executionRiskFactsChanged(
  i: OrderIntentRecord,
  deployment: DeploymentRecord,
  facts: ReturnType<typeof accountFacts>,
  db: Db,
) {
  return !isDeepStrictEqual(facts, accountFacts(i, deployment, db));
}

export function limitExecutionBuy(
  i: OrderIntentRecord,
  affordableQuantity: number,
  executePrice: number,
  deployment: DeploymentRecord,
  snapshot: Awaited<ReturnType<typeof readExecutionRiskSnapshot>> | null,
  db: Db,
  venueStep?: number,
) {
  const state = snapshot?.state;
  const recordLimit = (quantity: number, reason: string) => {
    appendExecutionAuditEvent(
      {
        deploymentId: i.deploymentId,
        runId: i.runId,
        intentId: i.id,
        eventType: "execution_risk_limit",
        details: {
          reason,
          plannedQuantity: i.quantity,
          quantity,
          executePrice,
          accountEquity: positive(state?.equity) ? state.equity : null,
        },
      },
      db,
    );
    return { quantity, reason };
  };
  if (!state || !positive(state.equity) || !Array.isArray(state.positions))
    return recordLimit(
      0,
      snapshot?.failure ?? "execution-risk-evidence-missing",
    );
  const facts = snapshot.facts;
  if (executionRiskFactsChanged(i, deployment, facts, db))
    return recordLimit(0, "execution-account-state-changed");
  const exposureSymbol = (raw: string) => {
    const symbol = normalizePoolSymbol(raw);
    return deployment.market === "crypto" ? symbol.replace(/^CX/, "") : symbol;
  };
  const symbol = exposureSymbol(i.symbol);
  const memberships =
    deployment.market === "cn-equity"
      ? decisionIndustries(i.decisionDate, db)
      : null;
  const groups = (s: string) =>
    memberships ? new Set(memberships.get(s) ?? ["unknown"]) : [];
  const targetIndustries = new Set(groups(symbol));
  const industryValues = new Map(
    Array.from(targetIndustries, (group) => [group, big(0)] as const),
  );
  const otherIndustryValues = new Map<string, ReturnType<typeof big>>();
  const market = deployment.market;
  const fixed = researchExecutionCosts(market, "fixed");
  const costsFor = (symbol: string, date: string) =>
    market === "cn-equity"
      ? executionCostsForInstrument(fixed, symbol, date)
      : fixed;
  const digits = moneyDigits(market);
  function buyFees(turnover: ReturnType<typeof big>, costs: typeof fixed) {
    const gross = turnover.round(digits);
    const bps = (rate: number) => gross.times(rate).div(10000).round(digits);
    const commission = bps(costs.commissionBps);
    return (
      commission.lt(costs.minimumCommission)
        ? big(costs.minimumCommission)
        : commission
    )
      .plus(bps(costs.slippageBps))
      .plus(bps(costs.transferBps ?? 0));
  }
  let symbolValue = big(0),
    equity = big(state.equity),
    totalValue = big(0);
  function addExposure(s: string, value: ReturnType<typeof big>) {
    if (s === symbol) symbolValue = symbolValue.plus(value);
    totalValue = totalValue.plus(value);
    for (const group of groups(s)) {
      const current = industryValues.get(group);
      if (current) industryValues.set(group, current.plus(value));
      else
        otherIndustryValues.set(
          group,
          (otherIndustryValues.get(group) ?? big(0)).plus(value),
        );
    }
  }
  for (const p of state.positions) {
    if (
      !Number.isFinite(p.quantity) ||
      p.quantity < 0 ||
      (p.quantity > 0 && !positive(p.lastPrice))
    )
      return recordLimit(0, "execution-risk-evidence-missing");
    if (p.quantity === 0) continue;
    const s = exposureSymbol(p.symbol);
    const price = s === symbol ? executePrice : p.lastPrice!;
    if (s === symbol)
      equity = equity.plus(big(price).minus(p.lastPrice!).times(p.quantity));
    addExposure(s, big(p.quantity).times(price));
  }
  for (const order of facts.commitments) {
    if (order.side !== "BUY" || isTerminalIntentStatus(order.status)) continue;
    const remaining = big(order.quantity).minus(order.filledQuantity);
    if (remaining.lte(0)) continue;
    const s = exposureSymbol(order.symbol);
    const price = arrivalEvidence(order.id, db)?.price ?? order.referencePrice;
    const turnover = remaining.times(
      s === symbol ? Math.max(price, executePrice) : price,
    );
    addExposure(s, turnover);
    equity = equity.minus(
      buyFees(turnover, costsFor(order.symbol, order.executeDate)),
    );
  }
  const verdict = getPipelineRun(i.runId, db)?.riskVerdict;
  const scale =
    verdict &&
    typeof verdict === "object" &&
    !Array.isArray(verdict) &&
    typeof verdict.entryScale === "number"
      ? verdict.entryScale
      : 1;
  const policy = deployment.riskPolicy;
  type Limit = [
    reason: string,
    weight: ReturnType<typeof big>,
    used: ReturnType<typeof big>,
  ];
  const limits: Limit[] = [
    [
      "instrument_cap",
      big(
        Math.min(policy.maxSymbolWeight, facts.accountCaps?.symbol ?? 1),
      ).times(scale),
      symbolValue,
    ],
    [
      "total_exposure_cap",
      big(
        Math.min(policy.maxTotalExposure, facts.accountCaps?.total ?? 1),
      ).times(scale),
      totalValue,
    ],
  ];
  const maxIndustryWeight = big(defaultPortfolioRiskPolicy.maxIndustryWeight);
  for (const used of industryValues.values())
    limits.push(["industry_cap", maxIndustryWeight, used]);
  const costs = costsFor(i.symbol, i.executeDate);
  function blockedBy(quantity: ReturnType<typeof big>) {
    const gross = quantity.times(executePrice);
    const netEquity = equity.minus(buyFees(gross, costs));
    let tightest: { reason: string; room: ReturnType<typeof big> } | undefined;
    for (const [reason, weight, used] of limits) {
      const room = netEquity.times(weight).minus(used);
      if (room.lt(gross) && (!tightest || room.lt(tightest.room)))
        tightest = { reason, room };
    }
    for (const used of otherIndustryValues.values()) {
      const room = netEquity.times(maxIndustryWeight).minus(used);
      if (room.lt(0) && (!tightest || room.lt(tightest.room)))
        tightest = { reason: "industry_cap", room };
    }
    return tightest?.reason;
  }
  const affordableBlock = blockedBy(big(affordableQuantity));
  if (!affordableBlock) return { quantity: affordableQuantity, reason: null };
  const rule =
    market === "cn-equity"
      ? resolveInstrumentRule(i.symbol, i.executeDate)
      : null;
  const step = rule
    ? big(Math.max(rule.buyQuantityStep, venueStep ?? 1))
    : big(10).pow(-quantityDigits(market));
  const minimum = rule ? big(rule.minimumBuyQuantity) : step;
  const minimumBlock = blockedBy(minimum);
  if (minimumBlock) return recordLimit(0, minimumBlock);

  // Both fees and exposure increase with quantity, so search valid lots using
  // the fees for each candidate, including the minimum commission and rounding.
  let lo = 0n;
  let hi = BigInt(
    big(affordableQuantity).minus(minimum).div(step).round(0, 0).toFixed(),
  );
  const quantityAt = (lots: bigint) =>
    minimum.plus(step.times(lots.toString()));
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (blockedBy(quantityAt(mid))) hi = mid - 1n;
    else lo = mid;
  }
  return recordLimit(
    quantityAt(lo).toNumber(),
    blockedBy(quantityAt(lo + 1n)) ?? affordableBlock,
  );
}
