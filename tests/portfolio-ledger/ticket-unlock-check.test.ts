import { describe, expect, it, vi } from "vitest";
import { sqlite } from "~/server/db";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import {
  confirmRebalancePlan,
  createRebalancePlan,
  getRebalancePlan,
} from "~/server/db/rebalance-plan-repository";
import { settings } from "~/server/infra/settings";
import { loadAccountBook } from "~/server/portfolio/account-workspace/load-book";
import { recheckRebalanceTicket } from "~/server/portfolio/rebalance-ticket-service";
import { checkTicketUnlockEvents } from "~/server/portfolio/ticket-unlock-check";
import type { StockEvent, StockEvents } from "~/server/research/stock-events";

const executeDate = "2026-11-23";
const stock = "sh600000";
const unlock = (date: string, title = "首发原股东限售股份"): StockEvent => ({
  date,
  type: "unlock",
  title,
  detail: null,
  tone: "neutral",
});
const events = (
  symbol: string,
  items: StockEvent[],
  failures: StockEvents["failures"] = [],
): StockEvents => ({
  version: "stock-events-1",
  symbol,
  fetchedAt: Date.parse("2026-11-22T15:00:00+08:00"),
  since: "2025-11-22",
  until: "2027-05-22",
  events: items,
  failures,
});

it("records an opening-window block if the unlock read finishes at 09:30", async () => {
  const asOfDate = "2026-11-20";
  const close = Date.parse(`${asOfDate}T15:05:00+08:00`);
  const opening = Date.parse(`${executeDate}T09:30:00+08:00`);
  const id = "unlock-opening-cutoff";
  let clock = opening - 1;
  try {
    createRebalancePlan(
      {
        id,
        accountId: "fixture",
        accountScope: "paper",
        sourceKind: "manual",
        sourceRefId: "fixture",
        asOfDate,
        executeDate,
        orders: [
          {
            side: "buy",
            symbol: stock,
            quantity: 100,
            maxBuyPrice: 10.2,
            atrStopPrice: 9,
            conditional: false,
            riskChecks: [],
          },
        ],
        riskSummary: { status: "normal", checks: [] },
        expiresAt: Date.parse(`${executeDate}T15:00:00+08:00`),
      },
      close,
    );
    confirmRebalancePlan(id, close);
    const ticket = await recheckRebalanceTicket(
      { id },
      {
        now: () => clock,
        loadBook: (_, at) =>
          loadAccountBook(new AccountWorkspaceRepository(), settings(), at, {
            localOnly: true,
            bars: {},
            context: {
              calendar: [asOfDate, executeDate],
              calendarSource: "fixture",
              today: executeDate,
              evidence: () => ({
                events: [],
                coverageEnd: executeDate,
                source: "fixture",
              }),
            },
          }),
        readQuotes: async () => [],
        readEvents: async (symbol) => {
          clock = opening;
          return events(symbol, []);
        },
      },
    );
    expect(ticket.recheckResult?.checks).toContainEqual(
      expect.objectContaining({ code: "window", status: "blocked" }),
    );
    expect(getRebalancePlan(id)?.recheckedAt).toBe(opening);
  } finally {
    sqlite().close();
  }
});
describe("checkTicketUnlockEvents", () => {
  it("warns with the exact date and title for an unlock five days out", async () => {
    const checks = await checkTicketUnlockEvents({
      symbols: [stock],
      executeDate,
      readEvents: async (symbol) => events(symbol, [unlock("2026-11-28")]),
    });
    expect(checks).toEqual([
      {
        code: "unlock",
        status: "warning",
        symbol: stock,
        detail: "未来 10 日内存在限售解禁（2026-11-28：首发原股东限售股份）",
      },
    ]);
  });

  it("includes the tenth calendar day and ignores the past or a later unlock", async () => {
    const readEvents = async (symbol: string) =>
      events(symbol, [
        unlock("2026-11-22"),
        unlock("2026-12-03"),
        unlock("2026-12-13"),
      ]);
    const checks = await checkTicketUnlockEvents({
      symbols: [stock],
      executeDate,
      readEvents,
    });
    expect(checks).toEqual([
      expect.objectContaining({
        status: "warning",
        detail: "未来 10 日内存在限售解禁（2026-12-03：首发原股东限售股份）",
      }),
    ]);
    const outside = await checkTicketUnlockEvents({
      symbols: [stock],
      executeDate,
      readEvents: async (symbol) =>
        events(symbol, [unlock("2026-11-22"), unlock("2026-12-13")]),
    });
    expect(outside).toEqual([
      {
        code: "unlock",
        status: "passed",
        symbol: stock,
        detail: "未来 10 日内无限售解禁",
      },
    ]);
  });

  it("skips ETF symbols without reading events", async () => {
    const readEvents = vi.fn(async (symbol: string) => events(symbol, []));
    const checks = await checkTicketUnlockEvents({
      symbols: ["sh510300", stock, "sh510300"],
      executeDate,
      readEvents,
    });
    expect(readEvents).toHaveBeenCalledTimes(1);
    expect(readEvents).toHaveBeenCalledWith(stock, expect.anything());
    expect(checks.map((check) => check.symbol)).toEqual([stock]);
  });

  it("returns unknown instead of throwing when the reader fails", async () => {
    const checks = await checkTicketUnlockEvents({
      symbols: [stock],
      executeDate,
      readEvents: async () => {
        throw new Error("网络不可用");
      },
    });
    expect(checks).toEqual([
      {
        code: "unlock",
        status: "unknown",
        symbol: stock,
        detail: "限售解禁事件暂不可查，请人工核对",
      },
    ]);
  });

  it("returns unknown when the unlock query itself failed", async () => {
    const checks = await checkTicketUnlockEvents({
      symbols: [stock],
      executeDate,
      readEvents: async (symbol) =>
        events(symbol, [], [{ type: "unlock", message: "限流" }]),
    });
    expect(checks).toEqual([
      expect.objectContaining({ status: "unknown", symbol: stock }),
    ]);
    const otherFailure = await checkTicketUnlockEvents({
      symbols: [stock],
      executeDate,
      readEvents: async (symbol) =>
        events(symbol, [], [{ type: "forecast", message: "限流" }]),
    });
    expect(otherFailure).toEqual([
      expect.objectContaining({ status: "passed", symbol: stock }),
    ]);
  });

  it.each([{ until: "2026-12-02" }, { since: "2026-11-24" }])(
    "returns unknown when the cached range has a gap (%o)",
    async (range) => {
      const checks = await checkTicketUnlockEvents({
        symbols: [stock],
        executeDate,
        readEvents: async (symbol) => ({ ...events(symbol, []), ...range }),
      });
      expect(checks).toEqual([
        {
          code: "unlock",
          status: "unknown",
          symbol: stock,
          detail: "限售解禁覆盖区间不足，请人工核对",
        },
      ]);
    },
  );

  it("limits each read to 2.5 seconds and groups unchecked symbols at six seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const readEvents = vi.fn(() => new Promise<StockEvents>(() => {}));
      const result = vi.fn();
      const checks = checkTicketUnlockEvents({
        symbols: [stock, "sh600001", "sh600002", "sh600003", "sh600004"],
        executeDate,
        readEvents,
      });
      void checks.then(result);
      await vi.advanceTimersByTimeAsync(2499);
      expect(readEvents).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(readEvents).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3500);
      expect(result).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ status: "unknown", symbol: stock }),
        expect.objectContaining({ status: "unknown", symbol: "sh600001" }),
        {
          code: "unlock",
          status: "unknown",
          detail: "限售解禁检查超时，请人工核对",
        },
      ]);
      expect(readEvents).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
