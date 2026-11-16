import type { Settings } from "~/lib/domain";
import { cryptoSymbol } from "~/lib/market/crypto";
import { beijingClock } from "~/lib/market/market-session";
import { AlertRepository } from "../db/alert-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { loadAccountBook } from "./account-workspace-service";
import { pageHoldingsCorrelation } from "./holdings-correlation-service";
import { readBars } from "../market/bar-store/read-bars";

/** A warning only: correlation never alters a strategy's ranking or order quantity. */
export async function planCorrelation(
  eventKey: string,
  config: Settings,
  now = Date.now(),
  repo = new AccountWorkspaceRepository(),
) {
  const event = new AlertRepository(repo.db).event(eventKey);
  if (!event || event.type !== "entry") throw new Error("入场候选不存在");
  const book = await loadAccountBook(repo, config, now);
  const positions = book.positions.filter(
    (p) => p.kind === "real" && p.market === event.market && p.quantity > 0,
  );
  if (!positions.length)
    return {
      pairs: [],
      reason: "该市场暂无真实持仓；相关性不包含纸面和机器人模拟库存",
    };
  const bars = { ...book.bars };
  if (!bars[event.symbol]) {
    try {
      const source = await readBars({
        instrument: {
          market: event.market,
          symbol:
            event.market === "crypto"
              ? cryptoSymbol(event.symbol.replace(/^cx/, ""))
              : event.symbol,
        },
        period: "day",
        adjustment: "none",
        root: config.tdxRoot,
        live: false,
        now,
        limit: 100,
      });
      bars[event.symbol] = source.bars.filter(
        (b) => !source.barStore.formingDates.includes(b.date),
      );
    } catch {
      return { pairs: [], reason: "缺少候选原价日线，相关性不可用" };
    }
  }
  const symbols = [
    ...new Set([...positions.map((p) => p.symbol), event.symbol]),
  ].sort();
  const dayMs = 86400000,
    today = Math.floor(now / dayMs) * dayMs;
  const wall = beijingClock(now);
  const calendar =
    event.market === "crypto"
      ? Array.from({ length: 62 }, (_, i) =>
          new Date(today - (62 - i) * dayMs).toISOString().slice(0, 10),
        )
      : book.calendar.filter(
          (date) =>
            date < wall.date || (date === wall.date && wall.minutes >= 905),
        );
  const quantities = Object.fromEntries(symbols.map((s) => [s, 1]));
  const matrix = pageHoldingsCorrelation(
    {
      days: calendar
        .slice(-61)
        .map((date) => ({ date, positions: quantities })),
      tradingDays: calendar,
      bars,
    },
    {
      pageIndex: Math.floor(symbols.indexOf(event.symbol) / 20),
      pageSize: 20,
      desc: false,
    },
  );
  const row = matrix.rows.find((r) => r.symbol === event.symbol);
  return {
    pairs: row
      ? matrix.symbols.flatMap((symbol, i) =>
          symbol === event.symbol
            ? []
            : [
                {
                  symbol,
                  correlation: row.cells[i]!.value,
                  overlapDays: row.cells[i]!.overlapDays,
                  warning:
                    row.cells[i]!.value !== null && row.cells[i]!.value! >= 0.7
                      ? "与现有持仓高度同向，请核对集中风险"
                      : row.cells[i]!.reason,
                },
              ],
        )
      : [],
    reason:
      "近60个市场日的相邻收盘价格收益；至少20个重叠日，仅作提示，不改变数量",
  };
}
