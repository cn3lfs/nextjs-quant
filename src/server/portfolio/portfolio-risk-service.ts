import { portfolioExecutionFee } from "quant-backtest";
import {
  defaultPortfolioRiskPolicy,
  evaluatePortfolioRisk,
  isCnEtfSymbol,
  resolveInstrumentRule,
  sizeEntryWithRisk,
  wilderAtr14,
  type PortfolioRiskDecision,
  type PortfolioRiskPolicy,
  type PortfolioRiskState,
} from "quant-execution";
import {
  defaultExecutionCosts,
  executionCostsForInstrument,
} from "trading-strategy-core/costs";
import { big } from "trading-strategy-core/money";
import { classifySecurityCode } from "trading-strategy-core/security";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { readSnapshot } from "tstdx/local";
import { z } from "zod";
import { industryGroupsFor } from "~/lib/portfolio/account-workspace";
import { reviewTradeNav } from "~/lib/portfolio/trade-review-nav";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { settings } from "../infra/settings";
import { fullLocalCalendarReference } from "../market/data-health";
import { loadAccountBook, type AccountBook } from "./account-workspace-service";
import { paperDailyBars } from "./account-workspace/daily-bars";

const fraction = z.number().finite().min(0).max(1);
export const portfolioRiskPolicySchema = z
  .object({
    reduceThreshold: fraction,
    pauseThreshold: fraction,
    recoverThreshold: fraction,
    recoverConsecutiveDays: z.number().int().safe().positive(),
    reducedScale: fraction,
    maxTotalStopRisk: fraction,
    maxIndustryWeight: fraction,
    maxSingleInstrumentWeight: fraction,
    maxEtfWeight: fraction.nullable(),
    riskPerTrade: fraction,
    atrStopMultiple: z.number().finite().positive(),
    missingStopFraction: fraction.refine((value) => value > 0).nullable(),
  })
  .partial()
  .strict()
  .refine(
    (overrides) => {
      const p = { ...defaultPortfolioRiskPolicy, ...overrides };
      return (
        p.recoverThreshold < p.reduceThreshold &&
        p.reduceThreshold < p.pauseThreshold
      );
    },
    { message: "回撤阈值须满足恢复 < 减仓 < 暂停" },
  );

const riskInput = z
  .object({
    scope: z.enum(["real", "paper"]).default("real"),
    account: z.string().trim().min(1).max(200).optional(),
    policy: portfolioRiskPolicySchema.optional(),
  })
  .strict();
export const accountPortfolioRiskInputSchema = riskInput.default({});
export const accountEntrySizingInputSchema = riskInput.extend({
  symbol: symbolSchema.refine((symbol) => {
    const code = classifySecurityCode(symbol.slice(2));
    return (
      isCnEtfSymbol(symbol) ||
      (code.market === symbol.slice(0, 2) &&
        (code.instrument === "stock" || code.instrument === "fund") &&
        !/^(sh900|sz200)/.test(symbol))
    );
  }, "仅支持 A 股股票与基金"),
  price: z.number().finite().positive(),
  atr: z.number().finite().positive().optional(),
  stopPrice: z.number().finite().positive().optional(),
  industry: z.string().trim().min(1).max(100).optional(),
  requestedQuantity: z.number().int().safe().positive().optional(),
});
export type AccountPortfolioRiskInput = z.input<
  typeof accountPortfolioRiskInputSchema
>;
export type AccountEntrySizingInput = z.input<
  typeof accountEntrySizingInputSchema
>;
export type AccountRiskScope = z.output<typeof riskInput>["scope"];

type RiskClose = {
  date: string;
  equity: number | null;
  cash: number | null;
  marketValue: number | null;
  growth: number | null;
  unitNav?: number;
};
type LedgerHistory = {
  account: string;
  opening: number | null;
  closes: RiskClose[];
  hasExternalFlows: boolean;
  reasons: string[];
};
const positive = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value) && value > 0;
const completed = (date: string, now: ReturnType<typeof chinaClock>) =>
  date < now.date || (date === now.date && now.time >= "15:05");

function deliveryHistory(
  book: AccountBook,
  account: string,
  calendar: string[],
  now: ReturnType<typeof chinaClock>,
): LedgerHistory {
  const history: LedgerHistory = {
    account,
    opening: null,
    closes: [],
    reasons: [],
    hasExternalFlows: false,
  };
  const fills = book.facts.fills.filter(
    (fill) => fill.account === account && completed(fill.tradeDate, now),
  );
  const flows = book.facts.cashFlows.filter(
    (flow) => flow.account === account && completed(flow.flowDate, now),
  );
  const dates = [
    ...fills.map((fill) => fill.tradeDate),
    ...flows.map((flow) => flow.flowDate),
  ].sort();
  if (!dates.length || dates.some((day) => !calendar.includes(day))) {
    history.reasons.push(`${account} 缺少账本流水或覆盖流水的完整交易日历`);
    return history;
  }
  const nav = reviewTradeNav({
    fills,
    cashFlows: flows,
    bars: book.bars,
    tradingDays: calendar.filter((day) => day >= dates[0]!),
  });
  const first = nav.days[0];
  const funding = flows.filter(
    (flow) =>
      flow.kind === "transferIn" &&
      flow.flowDate === first?.date &&
      flow.amount > 0,
  );
  // A zero-opening book can start at a proved first funding event, using that
  // deposit as capital before any fills. A later cash anchor proves no such basis.
  const firstFunding =
    nav.openingCash === 0 &&
    funding.length === 1 &&
    nav.replay[0]?.originalOrder ===
      fills.length + flows.indexOf(funding[0]!) &&
    nav.replay[0]?.cash === funding[0]!.amount
      ? funding[0]
      : undefined;
  history.opening = firstFunding?.amount ?? nav.openingCash;
  history.hasExternalFlows = flows.some(
    (flow) =>
      flow !== firstFunding &&
      flow.amount !== 0 &&
      (flow.kind === "transferIn" || flow.kind === "transferOut"),
  );
  history.closes = nav.days.map((day, i) => ({
    date: day.date,
    equity: day.nav.value,
    cash: day.cash.value,
    marketValue: day.marketValue.value,
    growth:
      day.dailyReturn.value !== null
        ? day.dailyReturn.value + 1
        : i === 0 &&
            firstFunding &&
            funding.length === 1 &&
            !flows.some(
              (flow) =>
                flow !== firstFunding &&
                flow.flowDate === day.date &&
                flow.amount !== 0 &&
                (flow.kind === "transferIn" || flow.kind === "transferOut"),
            ) &&
            !nav.warnings.some(
              (warning) =>
                warning.startsWith(`${day.date} 原始行`) &&
                warning.includes("待核对"),
            ) &&
            positive(day.nav.value)
          ? day.nav.value / firstFunding.amount
          : null,
  }));
  const badReturn = nav.days.find(
    (day, i) => history.closes[i]!.growth === null,
  );
  if (badReturn)
    history.reasons.push(
      `${account} ${badReturn.date} ${badReturn.dailyReturn.reason ?? "单位净值不可得"}`,
    );

  const holdingRanges = new Map<string, [string, string]>();
  for (const [i, day] of nav.days.entries()) {
    for (const symbol of Object.keys({
      ...nav.days[i - 1]?.positions,
      ...day.positions,
    })) {
      const range = holdingRanges.get(symbol) ?? [day.date, day.date];
      range[1] = day.date;
      holdingRanges.set(symbol, range);
    }
  }
  for (const [symbol, [from, to]] of holdingRanges) {
    const evidence = book.context.evidence(symbol);
    if (
      !evidence.coverageEnd ||
      evidence.coverageEnd < to ||
      evidence.events.some(
        (event) =>
          event.date >= from &&
          event.date <= to &&
          [1, 11, 12].includes(event.category),
      )
    )
      history.reasons.push(
        `${account} ${symbol} 持有期的原价净值缺少可核验的除权与股份依据`,
      );
  }
  if (
    fills.some(
      (fill) => !["stock", "fund", "reverseRepo"].includes(fill.instrument),
    )
  )
    history.reasons.push(
      `${account} 存在须先核定原始数量与估值单位的交割单证券`,
    );
  return history;
}

function riskContext(
  book: AccountBook,
  input: z.output<typeof riskInput>,
  at: number,
) {
  const policy: PortfolioRiskPolicy = {
    ...defaultPortfolioRiskPolicy,
    ...input.policy,
  };
  const now = chinaClock(at);
  const eligible = (account: string) =>
    input.account === undefined || input.account === account;
  const paper =
    input.scope === "paper"
      ? book.facts.paper.filter(
          ({ account }) =>
            account.market === "cn-equity" &&
            account.currency === "CNY" &&
            eligible(account.id),
        )
      : [];
  const calendar = [
    ...new Set(
      input.scope === "real"
        ? book.calendar
        : paper.flatMap(
            ({ state }) =>
              state?.request.calendar.map((date) => date.slice(0, 10)) ?? [],
          ),
    ),
  ]
    .sort()
    .filter((day) => completed(day, now));
  const histories: LedgerHistory[] =
    input.scope === "real"
      ? [...new Set(book.facts.batches.map((batch) => batch.account))]
          .filter(eligible)
          .map((account) => deliveryHistory(book, account, calendar, now))
      : paper.map(({ account, state }) => {
          const history: LedgerHistory = {
            account: account.id,
            opening: account.initial,
            closes: [],
            hasExternalFlows: false,
            reasons: [],
          };
          if (!state) {
            history.reasons.push(`${account.id} 暂无纸面账本快照`);
            return history;
          }
          const intraday = state.request.strategies.some((strategy) =>
            /^\d+[mh]$/.test(strategy.period),
          );
          const finished = new Set(
            state.result.curve
              .filter((row) => row.date.slice(11, 19) === "15:00:00")
              .map((row) => row.date.slice(0, 10)),
          );
          const omitted = new Set(state.result.riskAudit?.missingCloses ?? []);
          const recordedUnits = new Map(
            state.result.riskAudit?.daily.map((row) => [row.date, row.unitNav]),
          );
          history.hasExternalFlows = !!state.request.externalCashFlows?.some(
            (flow) =>
              flow.amount !== 0 && completed(flow.date.slice(0, 10), now),
          );
          let previous = account.initial;
          let previousUnit = 1;
          for (const row of state.result.equity) {
            if (
              !completed(row.date, now) ||
              (intraday && !finished.has(row.date))
            )
              continue;
            if (omitted.has(row.date))
              history.reasons.push(
                `${account.id} ${row.date} 缺少纸面持仓收盘估值`,
              );
            // The frozen audit records units using the marked value at the
            // transfer. Recompute only the tier under the requested policy.
            const unitNav = history.hasExternalFlows
              ? recordedUnits.get(row.date)
              : undefined;
            if (history.hasExternalFlows && unitNav === undefined)
              history.reasons.push(
                `${account.id} ${row.date} 纸面出入金缺少可重放的单位净值`,
              );
            history.closes.push({
              date: row.date,
              equity: row.equity,
              cash: row.cash,
              marketValue: big(row.equity).minus(row.cash).toNumber(),
              unitNav,
              growth:
                unitNav !== undefined && positive(previousUnit)
                  ? unitNav / previousUnit
                  : positive(previous)
                    ? row.equity / previous
                    : null,
            });
            previous = row.equity;
            if (unitNav !== undefined) previousUnit = unitNav;
          }
          if (!history.closes.length)
            history.reasons.push(`${account.id} 缺少完整纸面交易日收盘`);
          return history;
        });
  if (input.scope === "real" && book.facts.local.length && eligible("手工账本"))
    histories.push({
      account: "手工账本",
      opening: null,
      closes: [],
      hasExternalFlows: false,
      reasons: ["手工账本未记录可核验的期初现金和出入金"],
    });
  const accounts = histories.map(({ account }) => account);
  const positions = book.positions.filter(
    (pos) =>
      pos.kind === input.scope &&
      pos.market === "cn-equity" &&
      pos.currency === "CNY" &&
      accounts.includes(pos.account) &&
      pos.quantity !== 0,
  );
  const latest =
    histories
      .map((history) => history.closes.at(-1)?.date)
      .filter((date) => date !== undefined)
      .sort()
      .at(-1) ?? null;
  const lastCloses = histories.map((history) => history.closes.at(-1));
  const current = (key: "cash" | "equity" | "marketValue") =>
    latest !== null &&
    lastCloses.every(
      (row) =>
        row?.date === latest && row[key] !== null && Number.isFinite(row[key]),
    )
      ? lastCloses.reduce((total, row) => total + row![key]!, 0)
      : null;
  const cash = current("cash");
  const equity = current("equity");
  const marketValue = current("marketValue");
  const reasons = histories.flatMap((history) => history.reasons);
  if (!accounts.length) reasons.push("未找到选定范围的人民币 A 股账本");
  if (latest && lastCloses.some((row) => row?.date !== latest))
    reasons.push("账本收盘日期不一致，无法合并净值与现金");
  if (
    histories.length > 1 &&
    histories.some((history) => history.hasExternalFlows)
  )
    reasons.push("跨账户出入金缺少同一时点的组合流前估值");
  let state: PortfolioRiskState | null = null;
  if (latest && !reasons.length) {
    const byDay = histories.map(
      (history) => new Map(history.closes.map((day) => [day.date, day])),
    );
    const first = histories
      .map((history) => history.closes[0]!.date)
      .sort()[0]!;
    const dates = calendar.filter((day) => day >= first && day <= latest);
    let unitNav = big(1);
    let previousDate: string | undefined;
    for (const day of dates) {
      const active = histories.flatMap((history, index) => {
        if (day < history.closes[0]!.date) return [];
        const close = byDay[index]!.get(day);
        const prior =
          history.closes[0]!.date === day
            ? history.opening
            : byDay[index]!.get(previousDate ?? "")?.equity;
        return [{ close, prior }];
      });
      const invalid =
        !active.length ||
        active.some(
          ({ close, prior }) =>
            !positive(prior) ||
            close?.growth == null ||
            !Number.isFinite(close.growth) ||
            close.growth < 0 ||
            close.equity == null ||
            close.equity < 0,
        );
      if (invalid) {
        reasons.push(`${day} 组合缺少连续、可核验的收盘净值`);
        state = null;
        break;
      }
      const growth =
        histories.length === 1 && histories[0]!.hasExternalFlows
          ? big(active[0]!.close!.growth!)
          : active
              .reduce((n, { close }) => n.plus(close!.equity!), big(0))
              .div(active.reduce((n, { prior }) => n.plus(prior!), big(0)));
      const frozenUnit =
        histories.length === 1 ? active[0]!.close!.unitNav : undefined;
      unitNav =
        frozenUnit === undefined
          ? unitNav.times(growth).round(24)
          : big(frozenUnit);
      state = evaluatePortfolioRisk({
        date: day,
        unitNav: unitNav.toNumber(),
        previous: state,
        previousSessionDate: previousDate,
        policy,
      });
      previousDate = day;
    }
  }
  return {
    policy,
    now,
    calendar,
    positions,
    accounts,
    latest,
    cash,
    equity,
    marketValue,
    reasons,
    state,
  };
}

function riskSnapshot(
  book: AccountBook,
  input: z.output<typeof riskInput>,
  at: number,
) {
  const context = riskContext(book, input, at);
  const { policy, positions, state, equity, cash, latest, reasons } = context;
  const activeAccounts = new Set(context.accounts);
  const afterClose = (day: string) =>
    latest !== null && day > latest && day <= context.now.date;
  const newerActivity =
    book.trades.some(
      (trade) =>
        trade.kind === input.scope &&
        activeAccounts.has(trade.account) &&
        trade.market === "cn-equity" &&
        afterClose(trade.date.slice(0, 10)),
    ) ||
    (input.scope === "real" &&
      book.facts.cashFlows.some(
        (flow) => activeAccounts.has(flow.account) && afterClose(flow.flowDate),
      ));
  const latestMarketClose = book.calendar.reduce<string | null>(
    (last, day) =>
      completed(day, context.now) && (!last || day > last) ? day : last,
    null,
  );
  const stale =
    latest !== null && latestMarketClose !== null && latest < latestMarketClose;
  if (newerActivity)
    reasons.push("账本已有收盘点之后的成交或资金变动，资金与持仓待同日估值");
  if (stale) reasons.push("账本估值日期落后于最近确认的交易日收盘");
  const holdings = positions.map((position) => ({
    id: position.id,
    symbol: position.symbol,
    quantity: position.quantity,
    mark:
      positive(position.price) &&
      positive(position.value) &&
      position.at?.slice(0, 10) === latest
        ? position.price
        : null,
    stopPrice: positive(position.stop) ? position.stop : null,
    groups: industryGroupsFor(position),
  }));
  const missingMarks = holdings.filter(
    (row) => row.mark === null || !positive(row.quantity),
  );
  const missingStops = holdings.filter((row) => row.stopPrice === null);
  if (missingMarks.length)
    reasons.push("部分持仓缺少同日且可核验的估值，敞口与试算无法确认");
  if (missingStops.length)
    reasons.push(
      policy.missingStopFraction === null
        ? "部分持仓缺少止损，当前政策阻断新增仓位"
        : "部分持仓缺少止损，按政策比例估算这部分敞口",
    );
  const marked = (row: (typeof holdings)[number]) =>
    big(row.mark!).times(row.quantity);
  const projectedValue = missingMarks.length
    ? null
    : holdings.reduce((value, row) => value.plus(marked(row)), big(0));
  const mismatchedHoldings =
    context.marketValue !== null &&
    projectedValue !== null &&
    projectedValue.minus(context.marketValue).abs().gt(0.005);
  const exposuresIncomplete = newerActivity || mismatchedHoldings;
  if (mismatchedHoldings)
    reasons.push("持仓市值与同日净值重放的证券市值不一致");
  const knownRisk = holdings.reduce(
    (total, row) =>
      row.mark !== null &&
      row.stopPrice !== null &&
      row.mark > row.stopPrice &&
      positive(row.quantity)
        ? total.plus(big(row.mark).minus(row.stopPrice).times(row.quantity))
        : total,
    big(0),
  );
  const estimatedMissing =
    exposuresIncomplete ||
    !context.accounts.length ||
    missingMarks.length ||
    (missingStops.length > 0 && policy.missingStopFraction === null)
      ? null
      : missingStops.reduce(
          (total, row) =>
            total.plus(marked(row).times(policy.missingStopFraction ?? 0)),
          big(0),
        );
  const effective =
    estimatedMissing === null ? null : knownRisk.plus(estimatedMissing);
  const weight = (amount: ReturnType<typeof big> | null) =>
    !exposuresIncomplete && amount !== null && positive(equity)
      ? amount.div(equity).toNumber()
      : null;
  const concentration = (
    keyFor: (row: (typeof holdings)[number]) => string[],
    limitFor: (key: string) => number,
  ) => {
    const groups = new Map<string, typeof holdings>();
    for (const holding of holdings)
      for (const key of keyFor(holding)) {
        const rows = groups.get(key) ?? [];
        rows.push(holding);
        groups.set(key, rows);
      }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => {
        const amount =
          exposuresIncomplete ||
          rows.some((row) => row.mark === null || !positive(row.quantity))
            ? null
            : rows.reduce((total, row) => total.plus(marked(row)), big(0));
        const used = weight(amount);
        const limit = limitFor(key);
        return {
          key,
          marketValueCny: amount?.toNumber() ?? null,
          weight: used,
          limit,
          exceeded: used === null ? null : used > limit,
        };
      });
  };
  const riskWeight = weight(effective);
  const snapshot = {
    status:
      state &&
      positive(equity) &&
      cash !== null &&
      cash >= 0 &&
      !missingMarks.length &&
      !exposuresIncomplete &&
      !stale
        ? ("complete" as const)
        : ("incomplete" as const),
    scope: input.scope,
    currency: "CNY" as const,
    accounts: context.accounts,
    asOf: latest,
    stale,
    factVersion: book.facts.version,
    equityCny: equity,
    cashCny: cash,
    policy,
    state,
    recoveryDaysRemaining: state
      ? state.mode === "normal"
        ? 0
        : policy.recoverConsecutiveDays - state.recoveryCloses
      : null,
    stopRisk: {
      knownStopRiskCny:
        exposuresIncomplete || !context.accounts.length
          ? null
          : knownRisk.toNumber(),
      estimatedMissingStopRiskCny: estimatedMissing?.toNumber() ?? null,
      totalStopRiskCny: effective?.toNumber() ?? null,
      weight: riskWeight,
      limit: policy.maxTotalStopRisk,
      exceeded:
        riskWeight === null ? null : riskWeight > policy.maxTotalStopRisk,
      positionsWithStop: holdings.length - missingStops.length,
      missingStopPositions: missingStops.map(({ id, symbol }) => ({
        id,
        symbol,
      })),
      unvaluedPositions: missingMarks.map(({ id, symbol }) => ({ id, symbol })),
    },
    industries: concentration(
      (row) => (row.groups.length ? row.groups : ["unknown"]),
      () => policy.maxIndustryWeight,
    ),
    instruments: concentration(
      (row) => [row.symbol],
      (symbol) =>
        latest && resolveInstrumentRule(symbol, latest).kind === "etf"
          ? (policy.maxEtfWeight ?? policy.maxSingleInstrumentWeight)
          : policy.maxSingleInstrumentWeight,
    ),
    industrySource: book.industrySource,
    reasons,
  };
  return { snapshot, holdings, context };
}

export function evaluateAccountPortfolioRisk(
  book: AccountBook,
  value: AccountPortfolioRiskInput = {},
  at = Date.now(),
) {
  return riskSnapshot(book, accountPortfolioRiskInputSchema.parse(value), at)
    .snapshot;
}

export type AccountPortfolioRiskSnapshot = ReturnType<
  typeof evaluateAccountPortfolioRisk
>;

/** Read source files directly so these queries do not populate BarStore's disk cache. */
export async function readAccountSourceBars(root: string, symbol: string) {
  try {
    return (await readSnapshot(root, symbol, "day", { chartFunds: true })).bars;
  } catch {
    return [];
  }
}

export async function loadReadOnlyAccountBook(at = Date.now()) {
  const repo = new AccountWorkspaceRepository();
  const config = settings();
  const facts = repo.snapshot();
  const symbols = new Set([
    ...facts.fills.flatMap((fill) =>
      fill.symbol && (fill.instrument === "stock" || fill.instrument === "fund")
        ? [fill.symbol]
        : [],
    ),
    ...facts.local.map((trade) => trade.symbol),
  ]);
  const bars: AccountBook["bars"] = {};
  for (const symbol of symbols)
    bars[symbol] = await readAccountSourceBars(config.tdxRoot, symbol);
  repo.assertVersion(facts.version);
  return loadAccountBook(repo, config, at, { bars, localOnly: true });
}

export async function loadPortfolioRiskBook(
  scope: AccountRiskScope = "real",
  at = Date.now(),
) {
  const book = await loadReadOnlyAccountBook(at);
  const oldest = [
    ...book.facts.fills.map((fill) => fill.tradeDate),
    ...book.facts.cashFlows.map((flow) => flow.flowDate),
  ].sort()[0];
  if (scope === "real" && oldest && !book.calendar.includes(oldest)) {
    try {
      const reference = await fullLocalCalendarReference(
        book.config.tdxRoot,
        book.config.calendar,
      );
      return { ...book, calendar: reference.days };
    } catch {
      // deliveryHistory reports precisely which ledger cannot be covered.
    }
  }
  return book;
}

export async function simulateAccountEntrySizing(
  book: AccountBook,
  value: AccountEntrySizingInput,
  at = Date.now(),
) {
  const input = accountEntrySizingInputSchema.parse(value);
  const { snapshot, holdings, context } = riskSnapshot(book, input, at);
  const { symbol, price, stopPrice, requestedQuantity } = input;
  const { state, equity, cash, policy, latest } = context;
  const industries = industryGroupsFor({
    industryGroups: [
      ...(book.industryBySymbol.get(symbol) ?? []),
      input.industry ?? "",
    ],
  });
  if (!industries.length) industries.push("unknown");
  let atr = input.atr ?? null;
  let atrSource: "provided" | "wilder14" | null =
    atr === null ? null : "provided";
  const unavailable = (reason: string) => ({
    status: "incomplete" as const,
    scope: input.scope,
    currency: "CNY" as const,
    asOf: latest,
    symbol,
    price,
    atr,
    atrSource,
    industries,
    sizing: null,
    reasons: [...snapshot.reasons, reason],
  });
  if (
    !state ||
    !latest ||
    !positive(equity) ||
    cash === null ||
    cash < 0 ||
    snapshot.status !== "complete"
  )
    return unavailable(
      "账户资金、连续单位净值或同日持仓估值不足，不能计算定仓",
    );
  if (atr === null && stopPrice === undefined && state.mode !== "paused") {
    const paperBars =
      input.scope === "paper"
        ? snapshot.accounts.map(
            (account) => paperDailyBars(book, account)[symbol] ?? [],
          )
        : [];
    const local = book.bars[symbol]?.length
      ? book.bars[symbol]!
      : await readAccountSourceBars(book.config.tdxRoot, symbol);
    const bars =
      [local, ...paperBars].find((series) =>
        series.some((row) => row.date === latest),
      ) ?? [];
    const byDate = new Map<string, (typeof bars)[number] | null>();
    for (const bar of bars)
      byDate.set(bar.date, byDate.has(bar.date) ? null : bar);
    const contiguous = [];
    const atrCalendar = [...new Set([...context.calendar, ...book.calendar])]
      .filter((day) => day <= latest)
      .sort()
      .reverse();
    for (const day of atrCalendar) {
      const bar = byDate.get(day);
      if (!bar) break;
      contiguous.push(bar);
    }
    atr = wilderAtr14(contiguous.reverse());
    if (!positive(atr))
      return unavailable(
        `截至 ${latest} 缺少计算 Wilder ATR(14) 所需的连续有效原价日线`,
      );
    atrSource = "wilder14";
  }
  const costs = executionCostsForInstrument(
    {
      ...defaultExecutionCosts,
      transferSchedule: { kind: "cn-equity-transfer", multiplier: 1 },
    },
    symbol,
    latest,
  );
  const buyCost = (quantity: number) => {
    const notional = big(price).times(quantity);
    const estimatedFeesCny =
      quantity > 0 ? portfolioExecutionFee(quantity, price, "buy", costs) : 0;
    return {
      notionalCny: notional.toNumber(),
      estimatedFeesCny,
      cashRequiredCny: notional.plus(estimatedFeesCny).toNumber(),
    };
  };
  // The kernel accepts a single industry per trial. Evaluate each membership
  // independently so overlapping groups keep their full value and strictest cap.
  const decisions = industries.map((industry) =>
    sizeEntryWithRisk({
      equity,
      cash,
      symbol,
      date: latest,
      price,
      stopPrice,
      atr,
      requestedQuantity,
      cashCost: (quantity) => buyCost(quantity).cashRequiredCny,
      state,
      policy,
      industry,
      positions: holdings.map((row) => ({
        symbol: row.symbol,
        quantity: row.quantity,
        mark: row.mark!,
        stopPrice: row.stopPrice,
        industry: row.groups.includes(industry)
          ? industry
          : (row.groups[0] ?? "unknown"),
      })),
    }),
  );
  const decision = decisions.reduce((a, b) =>
    b.quantity < a.quantity ? b : a,
  );
  const sizing = {
    ...decision,
    reasons: [
      ...new Set(
        decisions.flatMap((row: PortfolioRiskDecision) => row.reasons),
      ),
    ],
    ...buyCost(decision.quantity),
    tradeRiskCny:
      decision.stopPrice === null
        ? 0
        : big(price)
            .minus(decision.stopPrice)
            .times(decision.quantity)
            .toNumber(),
  };
  return {
    status: "complete" as const,
    scope: input.scope,
    currency: "CNY" as const,
    asOf: latest,
    symbol,
    price,
    atr,
    atrSource,
    industries,
    sizing,
    reasons: snapshot.reasons,
  };
}

export type AccountEntrySizingPreview = Awaited<
  ReturnType<typeof simulateAccountEntrySizing>
>;
