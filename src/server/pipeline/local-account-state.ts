import type Database from "better-sqlite3";
import {
  evaluatePortfolioRisk,
  type PortfolioRiskState,
} from "quant-execution";
import { big } from "trading-strategy-core/money";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { getAccountRiskState } from "../db/account-risk-state-repository";
import { normalizePoolSymbol } from "../db/pool-repository";
import {
  SimAccountRepository,
  type SimRiskCheckpoint,
} from "../db/sim-account-repository";
import { fullLocalCalendarReference } from "../market/data-health";
import {
  moneyDigits,
  quantityDigits,
  replayPositions,
  type Market,
} from "../portfolio/sim-accounts/engine";
import { readDecisionBars } from "./universe-pool-runner";

type ReadPrice = (
  symbol: string,
  date: string,
) => number | null | Promise<number | null>;
type Flow = ReturnType<SimAccountRepository["decisionLedger"]>["flows"][number];
const dayMs = 86_400_000;
const dayAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const unitsOf = (atoms: bigint, digits: number) =>
  big(atoms.toString()).div(big(10).pow(digits));

function sessionCalendar(market: Market, dates: string[]) {
  const days = new Set(dates);
  const sorted = [...days].sort();
  function isSession(date: string) {
    if (market === "crypto") return true;
    if (sorted.length && sorted[0]! <= date && date <= sorted.at(-1)!)
      return days.has(date);
    const weekday = new Date(date).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  }
  function previous(date: string) {
    let ms = Date.parse(date) - dayMs;
    while (!isSession(dayAt(ms))) ms -= dayMs;
    return dayAt(ms);
  }
  return { isSession, previous };
}

function localCloses(end: string): ReadPrice {
  const history = new Map<string, Promise<Map<string, number>>>();
  return async (symbol, date) => {
    let rows = history.get(symbol);
    if (!rows) {
      rows = readDecisionBars(symbol, end).then(
        (bars) => new Map(bars.map((b) => [b.date, b.close])),
      );
      history.set(symbol, rows);
    }
    return (await rows).get(date) ?? null;
  };
}

export async function readLocalSimAccountState(
  simAccountId: string,
  decisionDate: string,
  db: Database.Database,
  readPrice: ReadPrice = localCloses(decisionDate),
  sellableDate = decisionDate,
  asOfCreatedAt = Date.now(),
) {
  researchDateSchema.parse(decisionDate);
  if (researchDateSchema.parse(sellableDate) < decisionDate)
    throw new Error("可卖日期早于决策日");
  const repo = new SimAccountRepository(db);
  const { market, flows, fills, cutoff } = repo.read(() =>
    repo.decisionLedger(simAccountId, decisionDate, asOfCreatedAt),
  );
  const settings = new AccountWorkspaceRepository(db).record<{
    calendar?: string[];
    tdxRoot?: string;
  }>("settings");
  let sessions = settings?.calendar ?? [];
  if (market === "cn-equity" && !sessions.length && settings?.tdxRoot)
    sessions = (await fullLocalCalendarReference(settings.tdxRoot, [])).days;
  const calendar = sessionCalendar(market, sessions);
  const completed =
    market === "cn-equity"
      ? completedBarFilter("day", asOfCreatedAt)
      : (date: string) => Date.parse(date) + dayMs <= asOfCreatedAt;
  const cashDigits = moneyDigits(market),
    qtyDigits = quantityDigits(market);
  const marks = new Map<string, Promise<number | null>>();
  function close(symbol: string, date: string) {
    const key = date + ":" + symbol;
    let p = marks.get(key);
    if (!p) {
      p = Promise.resolve(readPrice(symbol, date)).then((v) =>
        v !== null && Number.isFinite(v) && v > 0 ? v : null,
      );
      marks.set(key, p);
    }
    return p;
  }

  const head = getAccountRiskState(
    { accountScope: "local_sim", accountId: simAccountId },
    db,
  );
  const anchorDate =
    head && head.asOfDate < decisionDate
      ? head.asOfDate
      : calendar.previous(decisionDate);
  const candidate = repo.riskCheckpoint(simAccountId, anchorDate);
  // Ledger rows are immutable and the creation cutoff orders their visible sets.
  // A late backfill increases the prefix count and invalidates its old close.
  const anchor =
    candidate &&
    candidate.asOfCreatedAt <= cutoff &&
    candidate.flowCount === flows.filter((f) => f.asOfDate <= anchorDate).length
      ? candidate
      : null;
  let risk: PortfolioRiskState | undefined = anchor?.risk;
  let units = big(anchor?.units ?? 0);
  let redemptionNav = big(anchor?.redemptionNav ?? 1);
  let cashAtoms = 0n;
  const quantities = new Map<string, bigint>();
  // Fills known before an intraday flow are fresher than the preceding close.
  const intradayMarks = new Map<string, number>();
  let fundingKnown = true;
  let historyKnown = true;
  let cursor = 0;
  function settle(flow: Flow) {
    if (
      flow.symbol === null ||
      flow.side === null ||
      flow.quantity === null ||
      flow.price === null
    )
      throw new Error("模拟账户结算流水缺少成交");
    const symbol = normalizePoolSymbol(flow.symbol);
    const quantity =
      (quantities.get(symbol) ?? 0n) +
      (flow.side === "buy" ? flow.quantity : -flow.quantity);
    if (quantity === 0n) quantities.delete(symbol);
    else quantities.set(symbol, quantity);
    intradayMarks.set(
      symbol,
      unitsOf(flow.price, Number(flow.priceDigits ?? cashDigits)).toNumber(),
    );
  }
  async function equityAt(date: string, useFills: boolean) {
    let equity = unitsOf(cashAtoms, cashDigits);
    for (const [symbol, quantity] of quantities) {
      const price =
        (useFills ? intradayMarks.get(symbol) : undefined) ??
        (await close(symbol, date));
      if (price === null) return null;
      equity = equity.plus(unitsOf(quantity, qtyDigits).times(price));
    }
    return equity;
  }
  async function fund(flow: Flow) {
    if (flow.kind === "opening") {
      units = units.plus(unitsOf(flow.delta, cashDigits));
      return;
    }
    if (!fundingKnown || flow.delta === 0n) return;
    const postClose =
      market === "cn-equity" &&
      calendar.isSession(flow.asOfDate) &&
      completedBarFilter("day", Number(flow.occurredAt))(flow.asOfDate);
    const before = await equityAt(
      postClose ? flow.asOfDate : calendar.previous(flow.asOfDate),
      !postClose,
    );
    if (before === null) {
      fundingKnown = false;
      return;
    }
    const nav =
      units.gt(0) && before.gt(0)
        ? before.div(units)
        : before.eq(0) && units.eq(0)
          ? redemptionNav
          : null;
    if (!nav) {
      fundingKnown = false;
      return;
    }
    units = before.plus(unitsOf(flow.delta, cashDigits)).div(nav);
    redemptionNav = nav;
    fundingKnown = units.gte(0);
  }
  // Rebuild the raw cash/positions prefix without fetching historical quotes.
  if (anchor) {
    for (; cursor < anchor.flowCount; cursor++) {
      const flow = flows[cursor]!;
      if (flow.kind === "settlement") settle(flow);
      cashAtoms += flow.delta;
    }
  }
  const start = anchor
    ? Date.parse(anchor.risk.date) + dayMs
    : Date.parse(flows[0]?.asOfDate ?? decisionDate);
  const checkpoints: SimRiskCheckpoint[] = [];
  for (let ms = start; ms <= Date.parse(decisionDate); ms += dayMs) {
    const date = dayAt(ms);
    intradayMarks.clear();
    while (cursor < flows.length && flows[cursor]!.asOfDate === date) {
      const flow = flows[cursor++]!;
      if (flow.kind === "settlement") settle(flow);
      else await fund(flow);
      cashAtoms += flow.delta;
    }
    if (
      !historyKnown ||
      !fundingKnown ||
      !units.gt(0) ||
      !calendar.isSession(date) ||
      !completed(date)
    )
      continue;
    const equity = await equityAt(date, false);
    if (!equity || !equity.gt(0)) {
      historyKnown = false;
      continue;
    }
    risk = evaluatePortfolioRisk({
      date,
      unitNav: equity.div(units).toNumber(),
      previous: risk,
      previousSessionDate: calendar.previous(date),
    });
    checkpoints.push({
      asOfCreatedAt: cutoff,
      flowCount: cursor,
      units: units.toString(),
      redemptionNav: redemptionNav.toString(),
      risk,
    });
  }
  const book = replayPositions(fills, market, sellableDate);
  const decisionClose =
    completed(decisionDate) && calendar.isSession(decisionDate);
  const knowledgeDate = dayAt(
    cutoff + (market === "cn-equity" ? 8 * 3_600_000 : 0),
  );
  const markDate = decisionClose
    ? decisionDate
    : completed(knowledgeDate) && calendar.isSession(knowledgeDate)
      ? knowledgeDate
      : calendar.previous(knowledgeDate);
  const positions = await Promise.all(
    Array.from(book, async ([rawSymbol, lot]) => {
      const symbol = normalizePoolSymbol(rawSymbol);
      return {
        symbol,
        quantity: unitsOf(lot.quantity, qtyDigits).toNumber(),
        sellable: unitsOf(lot.sellable, qtyDigits).toNumber(),
        lastPrice:
          (!decisionClose && intradayMarks.get(symbol)) ||
          (await close(symbol, markDate)),
      };
    }),
  );
  const cash = unitsOf(cashAtoms, cashDigits);
  const equity = positions.reduce(
    (sum, p) =>
      p.lastPrice === null ? sum : sum.plus(big(p.quantity).times(p.lastPrice)),
    cash,
  );
  const observed =
    fundingKnown &&
    historyKnown &&
    units.gt(0) &&
    equity.gt(0) &&
    positions.every((p) => p.lastPrice !== null)
      ? risk
      : undefined;
  repo.saveRiskCheckpoints(simAccountId, checkpoints);
  return {
    cash: cash.toNumber(),
    equity: equity.toNumber(),
    drawdownPct: observed?.drawdown ?? null,
    riskRegime:
      observed?.mode === "paused" ? ("halted" as const) : observed?.mode,
    positions,
  };
}
