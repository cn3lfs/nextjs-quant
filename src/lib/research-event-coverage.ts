import type { Bar } from "./domain";
import type { VolumeEvidence } from "./research-volume-grid";
import type { TdxXdxr } from "~/server/tdx-wire";

export type EventCoverageStatus = "derived" | "unknown";
export type DailyEventCoverage = {
  date: string;
  availableAt: string | null;
  hasBar: boolean;
  priceLimit: {
    status: EventCoverageStatus;
    rate: number | null;
    up: number | null;
    down: number | null;
    touched: boolean | null;
    reason: string | null;
  };
  corporateAction: {
    status: EventCoverageStatus;
    present: boolean | null;
    categories: number[];
    reason: string | null;
  };
  suspension: {
    status: EventCoverageStatus;
    state: "trading" | "suspended" | "resumed" | "unknown";
    reason: string | null;
  };
};

export type DailyEventCoverageResult = {
  version: "daily-event-coverage-v1";
  source: "tdx-gbbq+daily-bars";
  symbol: string;
  board: "main" | "chinext" | "star" | "beijing" | "unknown";
  caveat: string;
  rows: DailyEventCoverage[];
};

function boardOf(symbol: string): DailyEventCoverageResult["board"] {
  if (symbol.startsWith("bj")) return "beijing";
  if (symbol.startsWith("sh68")) return "star";
  if (symbol.startsWith("sz30")) return "chinext";
  if (symbol.startsWith("sh") || symbol.startsWith("sz")) return "main";
  return "unknown";
}

function limitRate(board: DailyEventCoverageResult["board"], date: string) {
  if (board === "star") return date >= "2019-07-22" ? 0.2 : null;
  if (board === "chinext") return date >= "2020-08-24" ? 0.2 : 0.1;
  if (board === "beijing") return date >= "2021-11-15" ? 0.3 : null;
  if (board === "main") return 0.1;
  return null;
}

const roundPrice = (value: number) => Math.round(value * 100) / 100;

/**
 * Build a daily, auditable event table. Missing stock bars are represented as
 * unknown rather than being called a suspension; zero-volume bars are only a
 * derived suspension signal and remain distinct from missing-row inference.
 */
export function buildDailyEventCoverage(
  symbol: string,
  bars: readonly Bar[],
  events: readonly TdxXdxr[],
  calendar: readonly string[] = bars.map((bar) => bar.date.slice(0, 10)),
  gbbqAvailable = true,
): DailyEventCoverageResult {
  const board = boardOf(symbol);
  const byDate = new Map(bars.map((bar) => [bar.date.slice(0, 10), bar]));
  const actionsByDate = new Map<string, TdxXdxr[]>();
  for (const event of events) {
    const list = actionsByDate.get(event.date) ?? [];
    list.push(event);
    actionsByDate.set(event.date, list);
  }
  const dates = [...new Set(calendar.map((date) => date.slice(0, 10)))].sort();
  const rows: DailyEventCoverage[] = [];
  let previousBar: Bar | undefined;
  for (const date of dates) {
    const bar = byDate.get(date);
    const actions = actionsByDate.get(date) ?? [];
    const availableAt = bar ? `${date}T15:00:00+08:00` : null;
    const rate = limitRate(board, date);
    const priorClose = previousBar?.close;
    const canComputeLimit =
      !!bar &&
      !!previousBar &&
      priorClose != null &&
      Number.isFinite(priorClose) &&
      priorClose > 0 &&
      rate != null;
    const up = canComputeLimit ? roundPrice(priorClose! * (1 + rate!)) : null;
    const down = canComputeLimit ? roundPrice(priorClose! * (1 - rate!)) : null;
    const touched =
      canComputeLimit && up != null && down != null
        ? Math.abs(bar!.high - up) <= 0.011 ||
          Math.abs(bar!.low - down) <= 0.011
        : null;
    const actionCategories = [
      ...new Set(
        actions
          .filter((event) => event.category === 1)
          .map((event) => event.category),
      ),
    ];
    const priorVolume = previousBar?.volume;
    const suspension = !bar
      ? {
          status: "unknown" as const,
          state: "unknown" as const,
          reason: "缺K线，只能推断，不能证明停牌或复牌",
        }
      : bar.volume === 0
        ? {
            status: "derived" as const,
            state: "suspended" as const,
            reason: "日线存在但成交量为0；不能仅凭日线证明交易所停牌",
          }
        : priorVolume === 0
          ? {
              status: "derived" as const,
              state: "resumed" as const,
              reason: "本行有成交且上一存在行成交量为0，属于复牌候选",
            }
          : {
              status: "derived" as const,
              state: "trading" as const,
              reason: null,
            };
    rows.push({
      date,
      availableAt,
      hasBar: !!bar,
      priceLimit: {
        status: canComputeLimit ? "derived" : "unknown",
        rate,
        up,
        down,
        touched,
        reason: canComputeLimit
          ? null
          : !bar
            ? "缺日线"
            : !previousBar
              ? "缺前收，不能计算涨跌停价"
              : rate == null
                ? "板块或历史限制档位未知；首批/特殊交易日未冒充普通档位"
                : "前收无效",
      },
      corporateAction: {
        status: gbbqAvailable ? "derived" : "unknown",
        present: gbbqAvailable ? actionCategories.length > 0 : null,
        categories: actionCategories,
        reason: gbbqAvailable ? null : "GBBQ不可用，不能证明无除权事件",
      },
      suspension,
    });
    if (bar) previousBar = bar;
  }
  return {
    version: "daily-event-coverage-v1",
    source: "tdx-gbbq+daily-bars",
    symbol,
    board,
    caveat:
      "涨跌幅为按历史生效日与前收的常规档位派生；ST、上市/复牌首日等特殊身份未由本表证明。缺K线行标为unknown，不把推断写成停复牌证明。",
    rows,
  };
}

export function mergeVolumeEvidence(
  floatEvidence: VolumeEvidence,
  eventCoverage: DailyEventCoverageResult,
): VolumeEvidence {
  const merged: Record<string, VolumeEvidence[string]> = {};
  for (const row of eventCoverage.rows) {
    if (!row.hasBar) continue;
    const base = floatEvidence[row.date];
    const limit = row.priceLimit.touched;
    const corporateAction = row.corporateAction.present;
    const suspension =
      row.suspension.state === "suspended"
        ? true
        : row.suspension.status === "derived"
          ? false
          : null;
    const resumption =
      row.suspension.state === "resumed"
        ? true
        : row.suspension.status === "derived"
          ? false
          : null;
    if (base) {
      merged[row.date] = {
        ...base,
        limit,
        corporateAction,
        suspension,
        resumption,
      };
    } else {
      merged[row.date] = {
        date: row.date,
        availableDate: row.date,
        availableAt: row.availableAt ?? undefined,
        source: "tdx-gbbq:daily-event-coverage",
        limit,
        corporateAction,
        suspension,
        resumption,
      };
    }
  }
  return merged;
}
