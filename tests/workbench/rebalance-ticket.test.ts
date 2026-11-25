import { afterAll, describe, expect, it, vi } from "vitest";
import {
  defaultPortfolioRiskPolicy,
  evaluatePortfolioRisk,
} from "quant-execution";
import {
  buildRebalanceTicket,
  nextTicketSession,
  projectRebalanceTicket,
  recheckTicketEvidence,
  ticketReferenceLimits,
  type FrozenAllocation,
  type TicketAccountEvidence,
  type TicketInstrument,
  type TicketQuote,
} from "~/lib/portfolio/rebalance-ticket";
import { createTargetSnapshot } from "~/lib/research/alpha-experiment";
import { put, sqlite } from "~/server/db";
import { portfolioRouter } from "~/server/api/routers/portfolio";
import * as overviewQuotes from "~/server/market/overview-quotes";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { getRebalancePlan } from "~/server/db/rebalance-plan-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import type { PaperState } from "~/server/paper/model";
import { resolveRebalanceTargets } from "~/server/paper/rebalance-targets";
import { loadAccountBook } from "~/server/portfolio/account-workspace/load-book";
import { settings } from "~/server/infra/settings";
import {
  cancelRebalanceTicket,
  confirmRebalanceTicket,
  generateRebalanceTicket,
  listRebalanceTickets,
  readTicketAccountEvidence,
  readTicketQuotes,
  recheckRebalanceTicket,
  type TicketServiceSources,
} from "~/server/portfolio/rebalance-ticket-service";

const day = "2026-11-20",
  next = "2026-11-23",
  stock = "sh600000",
  star = "sh688001",
  etf = "sh518880";
const at = (date: string, time: string) =>
  Date.parse(date + "T" + time + ":00+08:00");
const close = at(day, "15:05"),
  opening = at(next, "09:25");
const allocation = (targets: Record<string, number>): FrozenAllocation => ({
  sourceKind: "manual",
  sourceRefId: "fixture",
  asOfDate: day,
  targets,
  scores: {},
});
const instrument = (symbol: string, quantity = 0): TicketInstrument => ({
  symbol,
  quantity,
  sellable: quantity,
  closeDate: day,
  close: 10,
  atr14: 0.2,
  stopPrice: 9,
  groups: [symbol],
});
function account(
  cash: number,
  instruments: TicketInstrument[],
): TicketAccountEvidence {
  return {
    asOfDate: day,
    cashCny: cash,
    equityCny: cash + instruments.reduce((s, i) => s + 10 * i.quantity, 0),
    state: evaluatePortfolioRisk({ date: day, unitNav: 1 }),
    policy: {
      ...defaultPortfolioRiskPolicy,
      riskPerTrade: 1,
      maxTotalStopRisk: 1,
      maxSingleInstrumentWeight: 1,
      maxIndustryWeight: 1,
    },
    issues: [],
    instruments,
  };
}
function draft(
  book: TicketAccountEvidence,
  targets: Record<string, number>,
  gap = 0.02,
) {
  return buildRebalanceTicket({
    allocation: allocation(targets),
    account: book,
    executeDate: next,
    maxGap: gap,
  });
}
function view(d: ReturnType<typeof draft>) {
  return projectRebalanceTicket(
    {
      ...d,
      id: "fixture",
      accountScope: "paper",
      accountId: "fixture",
      sourceKind: "manual",
      sourceRefId: "fixture",
      asOfDate: day,
      executeDate: next,
      expiresAt: at(next, "15:00"),
      status: "confirmed",
      createdAt: close,
      updatedAt: close,
      confirmedAt: close,
      recheckedAt: null,
      recheckResult: null,
    },
    opening,
  );
}
const quote = (
  symbol: string,
  overrides: Partial<TicketQuote> = {},
): TicketQuote => ({
  symbol,
  price: 10,
  observedAt: opening,
  tradingStatus: "trading",
  limitUp: 11,
  limitDown: 9,
  source: "冻结竞价夹具",
  ...overrides,
});

describe("frozen close and next exchange session", () => {
  it("requires the latest completed close and prefers the next evidenced session", () => {
    expect(
      nextTicketSession([day, "2026-11-21", "2026-11-22", next], day, close),
    ).toEqual({ executeDate: next, executeDateBasis: "market-calendar" });
    expect(() => nextTicketSession([day, next], day, at(day, "14:59"))).toThrow(
      "收盘",
    );
    expect(nextTicketSession([day, "2026-11-21"], day, close)).toEqual({
      executeDate: next,
      executeDateBasis: "next-weekday-unconfirmed",
    });
    expect(nextTicketSession([day, "2026-11-24"], day, close)).toEqual({
      executeDate: "2026-11-24",
      executeDateBasis: "market-calendar",
    });
    expect(() =>
      nextTicketSession([day, next], day, at(next, "15:05")),
    ).toThrow("收盘");
  });
  it("derives tick-rounded stock and ETF reference limits and preserves unknown inputs", () => {
    expect(ticketReferenceLimits(stock, next, 10)).toEqual({ up: 11, down: 9 });
    expect(ticketReferenceLimits(star, next, 10)).toEqual({ up: 12, down: 8 });
    expect(ticketReferenceLimits("sz300750", next, 10)).toEqual({
      up: 12,
      down: 8,
    });
    expect(ticketReferenceLimits("bj920001", next, 10)).toEqual({
      up: 13,
      down: 7,
    });
    expect(ticketReferenceLimits(etf, next, 1.234)).toEqual({
      up: 1.357,
      down: 1.111,
    });
    expect(ticketReferenceLimits("sh588000", next, 10)).toEqual({
      up: 12,
      down: 8,
    });
    expect(ticketReferenceLimits("sz159915", next, 10)).toEqual({
      up: 12,
      down: 8,
    });
    expect(ticketReferenceLimits("sz159999", next, 10, "双创50ETF")).toEqual({
      up: 12,
      down: 8,
    });
    expect(ticketReferenceLimits(stock, "2026-07-03", 10, "*ST浦发")).toEqual({
      up: 10.5,
      down: 9.5,
    });
    expect(ticketReferenceLimits(stock, "2026-07-06", 10, "*ST浦发")).toEqual({
      up: 11,
      down: 9,
    });
    expect(ticketReferenceLimits("sh000300", next, 10)).toBeNull();
    expect(ticketReferenceLimits("sz159999", next, 10)).toBeNull();
    expect(ticketReferenceLimits(etf, next, null)).toBeNull();
  });
  it("allocates main-board and ETF lots of 100 and STAR lots of 200 plus one, with tick-rounded caps", () => {
    const targets = { [stock]: 0.251, [star]: 0.251, [etf]: 0.251 };
    const t = view(
      draft(
        account(10000, [instrument(stock), instrument(star), instrument(etf)]),
        targets,
      ),
    );
    expect(
      Object.fromEntries(t.orders.map((o) => [o.symbol, o.quantity])),
    ).toEqual({ [stock]: 200, [star]: 246, [etf]: 200 });
    expect(t.orders.find((o) => o.symbol === etf)).toMatchObject({
      side: "buy",
      maxBuyPrice: 10.2,
      atrStopPrice: 9.6,
      conditional: false,
      estimate: {
        atr14: 0.2,
        settlementCycle: "T+0",
        estimatedNotionalCny: 2040,
        estimatedFeesCny: 5,
        cashRequiredCny: 2045,
      },
    });
    expect(t.orders.find((o) => o.symbol === stock)?.estimate).toMatchObject({
      settlementCycle: "T+1",
      estimatedFeesCny: 5.03,
    });
    expect(
      draft(account(1024, [instrument(etf)]), { [etf]: 1 }).orders,
    ).toEqual([]);
    expect(
      draft(account(1025, [instrument(etf)]), { [etf]: 1 }).orders[0]?.quantity,
    ).toBe(100);
  });
  it("uses net sell proceeds only once and checks the frozen budget against the latest sell quote", () => {
    const d = draft(account(5, [instrument(stock, 2000), instrument(etf)]), {
      [etf]: 1,
    });
    const t = view(d);
    expect(t.orders).toMatchObject([
      {
        side: "sell",
        quantity: 2000,
        conditional: false,
        estimate: { estimatedFeesCny: 16.2, netSaleProceedsCny: 19983.8 },
      },
      {
        side: "buy",
        quantity: 1900,
        conditional: true,
        estimate: { cashRequiredCny: 19385.82 },
      },
    ]);
    expect(
      recheckTicketEvidence(t, opening, d, [quote(stock), quote(etf)]).outcome,
    ).toBe("conditional");
    const refused = recheckTicketEvidence(t, opening, d, [
      quote(stock, { price: 9.5 }),
      quote(etf),
    ]);
    expect(refused.checks).toContainEqual(
      expect.objectContaining({ code: "cash", status: "blocked" }),
    );
    expect(refused.outcome).toBe("blocked");
  });
  it("keeps unsellable holdings in the position cap and carries no imaginary sale proceeds", () => {
    const a = account(10000, [
      { ...instrument(stock, 1000), sellable: 0 },
      instrument(etf),
    ]);
    a.maxPositions = 1;
    expect(draft(a, { [etf]: 0.4 }).orders).toEqual([]);
    a.state = evaluatePortfolioRisk({ date: day, unitNav: 0.9 });
    a.maxPositions = 10;
    expect(draft(a, { [etf]: 0.4 }).orders).toEqual([]);
  });
  it("returns a zero-order draft when aligned or below a legal lot; missing evidence blocks the whole ticket", () => {
    const a = account(10000, [instrument(stock, 1000), instrument(etf)]);
    expect(draft(a, { [stock]: 0.5 }).orders).toEqual([]);
    for (const b of [
      { ...a, cashCny: null },
      { ...a, asOfDate: "2026-11-19" },
      { ...a, state: null },
      { ...a, equityCny: 30000 },
      {
        ...a,
        instruments: [
          { ...a.instruments[0]!, sellable: null },
          instrument(etf),
        ],
      },
      {
        ...a,
        instruments: [
          a.instruments[0]!,
          { ...instrument(etf), closeDate: "2026-11-19" },
        ],
      },
      {
        ...a,
        instruments: [a.instruments[0]!, { ...instrument(etf), atr14: null }],
      },
    ]) {
      const d = draft(b, { [etf]: 0.5 });
      expect(d.orders).toEqual([]);
      expect(d.riskSummary.checks.some((c) => c.status === "blocked")).toBe(
        true,
      );
    }
  });
  it("never passes draft, stale, future, missing, suspended, at-limit, chase-gap or changed-risk evidence", () => {
    const d = draft(account(100000, [instrument(etf)]), { [etf]: 0.1 }),
      t = view(d);
    const check = (q: TicketQuote[]) =>
      recheckTicketEvidence(t, opening, d, q).outcome;
    expect(check([quote(etf)])).toBe("passed");
    expect(check([quote(etf, { limitUp: null })])).toBe("warning");
    expect(check([quote(etf, { tradingStatus: "unknown" })])).toBe("warning");
    for (const q of [
      [],
      [quote(etf, { price: null })],
      [quote(etf, { observedAt: opening - 60000 })],
      [quote(etf, { observedAt: opening + 1 })],
      [quote(etf, { tradingStatus: "suspended", limitUp: null })],
      [quote(etf, { price: 10.21 })],
      [quote(etf, { price: 10.2, limitUp: 10.2 })],
      [quote(etf, { price: 9.5 })],
    ])
      expect(check(q)).toBe("blocked");
    expect(
      recheckTicketEvidence({ ...t, status: "draft" }, opening, d, [quote(etf)])
        .outcome,
    ).toBe("blocked");
    expect(
      recheckTicketEvidence(t, opening, { ...d, orders: [] }, [quote(etf)])
        .outcome,
    ).toBe("blocked");
    expect(recheckTicketEvidence(t, opening, null, [quote(etf)]).outcome).toBe(
      "warning",
    );
    expect(recheckTicketEvidence(t, close, d, [quote(etf)]).outcome).toBe(
      "blocked",
    );
  });
});

const calendar = Array.from({ length: 30 }, (_, i) =>
  new Date(Date.UTC(2026, 9, 25 + i)).toISOString().slice(0, 10),
).filter((d) => {
  const w = new Date(d).getUTCDay();
  return w > 0 && w < 6 && d <= next;
});
const bars = calendar
  .filter((d) => d <= day)
  .map((date) => ({
    date,
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 2000,
    amount: 20000,
  }));
function seedPaper(
  id: string,
  scheduledTargets?: PaperState["request"]["scheduledTargets"],
) {
  const repo = new PaperRepository();
  repo.create({
    id,
    market: "cn-equity",
    currency: "CNY",
    sleeve: "main",
    startedAt: 1,
    initial: 100000,
    candidates: [],
    mirror: { venue: "off" },
    mirrorRevision: "1",
    revision: 1,
    lastBar: day,
    lastRun: close,
    error: null,
    summary: null,
  });
  repo.saveState(id, {
    request: {
      market: "cn-equity",
      start: bars[0]!.date,
      end: day,
      initial: 100000,
      calendar: bars.map((b) => b.date),
      strategies: [],
      scheduledTargets,
      sleeves: [],
      instruments: [
        {
          symbol: etf,
          market: "cn-equity",
          bars,
          signalBars: bars,
          execution: {
            evidence: "fixture",
            tradable: true,
            limitUp: null,
            limitDown: null,
          },
        },
      ],
    },
    result: {
      positions: [],
      equity: bars.map((b) => ({ date: b.date, equity: 100000, cash: 100000 })),
      curve: [],
      fills: [],
      orders: [],
    },
    benchmark: [],
    decisions: [],
  } as unknown as PaperState);
}
function fixtureSources(
  sessions = calendar,
): TicketServiceSources & { clock: number } {
  const deps = {
    clock: close,
    now: () => deps.clock,
    loadBook: async (_scope?: "real" | "paper", atTime = close) =>
      loadAccountBook(
        new AccountWorkspaceRepository(),
        { ...settings(), industryBlocksRoot: "" },
        atTime,
        {
          bars: { [etf]: bars },
          localOnly: true,
          context: {
            calendar: sessions,
            calendarSource: "固定交易所日历",
            today: day,
            evidence: () => ({
              events: [],
              coverageEnd: day,
              source: "fixture",
            }),
          },
        },
      ),
    readQuotes: async () => [quote(etf)],
  };
  return deps;
}
const changes = () =>
  (sqlite().prepare("SELECT total_changes() AS n").get() as { n: number }).n;
describe("isolated v24 ticket transitions", () => {
  it("declares the persisted recheck receipt as a configure operation", () => {
    expect(
      portfolioRouter._def.procedures.rebalanceTicketRecheck._def.meta,
    ).toEqual({
      capability: "portfolio",
      operation: "configure",
    });
  });
  it("persists inferred Monday execution and warns at recheck until the calendar confirms", async () => {
    const deps = fixtureSources(calendar.filter((date) => date <= day));
    const accountId = "paper-inferred-session";
    seedPaper(accountId);
    const account = { accountScope: "paper" as const, accountId };
    const input = {
      ...account,
      asOfDate: day,
      source: {
        kind: "manual" as const,
        sourceRefId: "收盘",
        targets: { [etf]: 0.1 },
      },
    };
    const first = await generateRebalanceTicket(input, deps);
    const second = await generateRebalanceTicket(input, deps);
    expect(first).toMatchObject({
      executeDate: next,
      executeDateBasis: "next-weekday-unconfirmed",
      executeDateNote: expect.stringContaining("盘前请复检"),
    });
    expect(
      listRebalanceTickets(account, close).items[0]?.executeDateBasis,
    ).toBe("next-weekday-unconfirmed");
    confirmRebalanceTicket({ id: first.id }, close);
    confirmRebalanceTicket({ id: second.id }, close);
    deps.clock = opening;
    const incomplete = await recheckRebalanceTicket({ id: first.id }, deps);
    expect(incomplete.recheckResult?.outcome).toBe("warning");
    expect(incomplete.recheckResult?.checks).toContainEqual(
      expect.objectContaining({ code: "calendar", status: "unknown" }),
    );
    const confirmed = fixtureSources();
    confirmed.clock = opening;
    const result = await recheckRebalanceTicket({ id: second.id }, confirmed);
    expect(result.recheckResult?.outcome).toBe("passed");
  });
  it("uses same-session ETF activity and production reference limits in the recheck receipt", async () => {
    const deps = fixtureSources();
    const accountId = "paper-market-evidence";
    seedPaper(accountId);
    const t = await generateRebalanceTicket(
      {
        accountScope: "paper",
        accountId,
        asOfDate: day,
        source: { kind: "manual", sourceRefId: "ETF", targets: { [etf]: 0.1 } },
      },
      deps,
    );
    confirmRebalanceTicket({ id: t.id }, close);
    deps.clock = opening;
    deps.readQuotes = readTicketQuotes;
    const fresh = {
      symbol: etf,
      price: 10.2,
      preClose: 9.273,
      amount: 5000,
      quoteTime: next + " 09:25:00",
    };
    const mock = vi.spyOn(overviewQuotes, "fetchOverviewQuotes");
    const feed = (quote: typeof fresh) => ({
      quotes: [quote],
      fetchedAt: opening,
      source: "腾讯实时" as const,
    });
    mock.mockResolvedValue(feed(fresh));
    try {
      const book = await deps.loadBook("paper", opening);
      expect(await readTicketQuotes(book, t, opening)).toMatchObject([
        { tradingStatus: "trading", limitUp: 10.2, limitDown: 8.346 },
      ]);
      mock.mockResolvedValueOnce(feed({ ...fresh, preClose: 0 }));
      expect(await readTicketQuotes(book, t, opening)).toMatchObject([
        { limitUp: null, limitDown: null },
      ]);
      mock.mockResolvedValueOnce(
        feed({ ...fresh, quoteTime: day + " 09:25:00" }),
      );
      expect(await readTicketQuotes(book, t, opening)).toMatchObject([
        { tradingStatus: "unknown", limitUp: null, limitDown: null },
      ]);
      const result = await recheckRebalanceTicket({ id: t.id }, deps);
      expect(result.recheckResult?.checks).toContainEqual(
        expect.objectContaining({
          code: "limits",
          symbol: etf,
          status: "blocked",
        }),
      );
      expect(
        result.recheckResult?.checks.some((check) => check.code === "halt"),
      ).toBe(false);
      put("security-trading-status", `security-trading-status-${etf}`, {
        version: "security-trading-status-1",
        symbol: etf,
        asOf: next,
        status: "suspended",
        fetchedAt: opening - 60000,
      });
      expect(await readTicketQuotes(book, t, opening)).toMatchObject([
        { tradingStatus: "suspended" },
      ]);
    } finally {
      mock.mockRestore();
    }
  });
  it("writes only a ticket and a single immutable receipt; a repeated list never changes the database", async () => {
    const deps = fixtureSources(),
      accountId = "paper-rebalance";
    seedPaper(accountId);
    expect(sqlite().pragma("user_version", { simple: true })).toBe(25);
    const account = { accountScope: "paper" as const, accountId };
    const paper = new PaperRepository(),
      checkpoint = paper.state(accountId);
    const initial = changes();
    const ticket = await generateRebalanceTicket(
      {
        ...account,
        asOfDate: day,
        source: {
          kind: "manual",
          sourceRefId: "用户收盘清单",
          targets: { [etf]: 0.1 },
        },
      },
      deps,
    );
    expect(ticket.orders).toHaveLength(1);
    expect(ticket.orders[0]).toMatchObject({
      side: "buy",
      // At the 10.20 cap and 9.60 stop, 900 shares risk 540 CNY.
      // The 500 CNY risk budget permits eight 100-share lots.
      quantity: 800,
      estimate: { cashRequiredCny: 8165, estimatedFeesCny: 5 },
    });
    expect(ticket.orders[0]?.estimate?.atr14).toBeCloseTo(0.2, 10);
    const action = { id: ticket.id };
    await expect(recheckRebalanceTicket(action, deps)).rejects.toThrow(
      "已确认",
    );
    expect(confirmRebalanceTicket(action, close).status).toBe("confirmed");
    await expect(recheckRebalanceTicket(action, deps)).rejects.toThrow("09:15");
    deps.clock = opening;
    const result = await recheckRebalanceTicket(action, deps);
    expect(result.recheckResult?.outcome).toBe("passed");
    await expect(recheckRebalanceTicket(action, deps)).rejects.toThrow(
      "一次复检",
    );
    expect(listRebalanceTickets(account, opening).items).toEqual([result]);
    expect(
      listRebalanceTickets(account, opening).items[0]?.allocation?.targets,
    ).toEqual({ [etf]: 0.1 });
    expect(changes() - initial).toBe(3);
    expect(cancelRebalanceTicket(action, opening).status).toBe("cancelled");
    expect(getRebalancePlan(ticket.id)?.recheckResult).toEqual(
      result.recheckResult,
    );
    expect(paper.state(accountId)).toEqual(checkpoint);
  });
  it("projects expiration without a list write; configure invokes physical v24 expiry at the boundary", async () => {
    const deps = fixtureSources(),
      accountId = "paper-expiry";
    seedPaper(accountId);
    const account = { accountScope: "paper" as const, accountId };
    const ticket = await generateRebalanceTicket(
      {
        ...account,
        asOfDate: day,
        source: { kind: "manual", sourceRefId: "cash", targets: {} },
      },
      deps,
    );
    expect(ticket.orders).toEqual([]);
    expect(() => confirmRebalanceTicket({ id: ticket.id }, close)).toThrow();
    const before = changes();
    expect(
      listRebalanceTickets(account, ticket.expiresAt).items[0]?.status,
    ).toBe("expired");
    expect(getRebalancePlan(ticket.id)?.status).toBe("draft");
    expect(changes()).toBe(before);
    expect(() =>
      cancelRebalanceTicket({ id: ticket.id }, ticket.expiresAt),
    ).toThrow();
    expect(getRebalancePlan(ticket.id)?.status).toBe("expired");
  });
  it("binds frozen source identity to the selected close, rejects forged Alpha hashes and stale ETF allocations", async () => {
    const book = await fixtureSources().loadBook("paper", close);
    const snap = await createTargetSnapshot(
      "a".repeat(64),
      { start: day, end: day },
      [{ date: day, scores: [{ symbol: stock, score: 4 }] }],
    );
    expect(
      (
        await resolveRebalanceTargets(
          { kind: "alpha", snapshot: snap },
          day,
          book,
        )
      ).sourceRefId,
    ).toContain(snap.snapshotHash);
    await expect(
      resolveRebalanceTargets(
        { kind: "alpha", snapshot: { ...snap, snapshotHash: "b".repeat(64) } },
        day,
        book,
      ),
    ).rejects.toThrow("摘要");
    const row = {
      strategyId: "etf-risk-budget" as const,
      sourceHash: "e".repeat(64),
      targets: { [etf]: 0.1 },
      scores: { [etf]: 1 },
      date: day,
      availableAt: day,
    };
    const frozen = await resolveRebalanceTargets(
      { kind: "etf_rotation", snapshot: row },
      day,
      book,
    );
    expect(frozen.sourceRefId).toContain(row.sourceHash);
    const altered = await resolveRebalanceTargets(
      { kind: "etf_rotation", snapshot: { ...row, targets: { [etf]: 0.2 } } },
      day,
      book,
    );
    expect(frozen.sourceRefId).not.toBe(altered.sourceRefId);
    await expect(
      resolveRebalanceTargets(
        { kind: "etf_rotation", snapshot: { ...row, availableAt: next } },
        day,
        book,
      ),
    ).rejects.toThrow("日期");
    await expect(
      resolveRebalanceTargets(
        { kind: "studio", paperAccountId: "absent", strategyId: "x" },
        day,
        book,
      ),
    ).rejects.toThrow("冻结快照");
  });
  it("generates and reads back frozen Alpha, ETF rotation and Studio source identities", async () => {
    const deps = fixtureSources();
    const account = {
      accountScope: "paper" as const,
      accountId: "paper-frozen-sources",
    };
    const row = {
      strategyId: "etf-risk-budget" as const,
      date: day,
      availableAt: day,
      sourceHash: "d".repeat(64),
      targets: { [etf]: 0.1 },
      scores: { [etf]: 1 },
    };
    const snapshot = await createTargetSnapshot(
      "a".repeat(64),
      { start: day, end: day },
      [{ date: day, scores: [{ symbol: etf, score: 1 }] }],
    );
    seedPaper(account.accountId, [row]);
    const sources = [
      { kind: "alpha", snapshot },
      { kind: "etf_rotation", snapshot: row },
      {
        kind: "studio",
        paperAccountId: account.accountId,
        strategyId: row.strategyId,
      },
    ] as const;
    const references = [
      snapshot.snapshotHash,
      row.sourceHash,
      account.accountId,
    ];
    for (const [index, source] of sources.entries()) {
      const ticket = await generateRebalanceTicket(
        { ...account, asOfDate: day, source },
        deps,
      );
      expect(ticket.orders).toHaveLength(1);
      expect(ticket.sourceKind).toBe(source.kind);
      expect(ticket.sourceRefId).toContain(references[index]);
      expect(ticket.allocation).toMatchObject({
        sourceKind: source.kind,
        sourceRefId: ticket.sourceRefId,
        targets: row.targets,
      });
    }
    expect(
      listRebalanceTickets(account, close)
        .items.map(({ sourceKind }) => sourceKind)
        .sort(),
    ).toEqual(["alpha", "etf_rotation", "studio"]);
  });
  it("holds back real orders when the account has no verified same-close cash", async () => {
    const book = await fixtureSources().loadBook("real", close);
    const evidence = await readTicketAccountEvidence(
      book,
      { accountScope: "real", accountId: "missing" },
      allocation({}),
      next,
      close,
    );
    expect(evidence.cashCny).toBeNull();
    expect(evidence.issues).toContain("真实交割单缺少决策日柜台现金余额依据");
  });
});
afterAll(() => sqlite().close());
