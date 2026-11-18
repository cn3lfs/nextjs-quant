import type { CloseScanPhase } from "~/lib/market/close-scan-window";
import type { WorkspaceCandidate } from "./candidate-table";

export type TodayMarket = "all" | "cn-equity" | "crypto";
export type MarketFilter = { market: TodayMarket; page: number };
export const todayMarketOptions = [
  { value: "all", label: "全部" },
  { value: "cn-equity", label: "A 股" },
  { value: "crypto", label: "数字货币" },
] as const satisfies readonly { value: TodayMarket; label: string }[];

/** The only key that reuses the today batch instead of the filtered query. */
export function isTodayBatch(market: TodayMarket, page: number) {
  return market === "all" && page === 0;
}

/** Market and page are one state: switching market always restarts at page 0. */
export function selectMarket(
  state: MarketFilter,
  market: TodayMarket,
): MarketFilter {
  return { market, page: 0 };
}

type CandidatePage = {
  items: WorkspaceCandidate[];
  total: number;
};

export type CandidateSource = "today" | "filtered" | "pending" | "error";
export const PENDING_CANDIDATE_MESSAGE = "正在读取候选…";
export type CandidateView = {
  source: CandidateSource;
  rows: WorkspaceCandidate[] | undefined;
  total: number | undefined;
  /** True only when this key has no rows yet; a same-key refresh keeps rows. */
  loading: boolean;
  error: string | null;
  /** Refresh failed while this key still shows an earlier successful read. */
  warning: string | null;
  /** The shown rows (or the empty state) come from an earlier successful read. */
  stale: boolean;
  emptyMessage: string | null;
};

/**
 * Only "all + first page" reuses the today batch; every other market/page key
 * is answered by the server-filtered query. A missing key never falls back to
 * the previous key's rows, so a loading or failed filter cannot show another
 * market's candidates or a false empty table.
 *
 * A refresh keeps the same key's rows: `fetching` never hides them, and a
 * failure retains them as a stale read with a warning instead of flashing an
 * empty error table. Only a first read with no rows becomes an error.
 */
export function candidateView(input: {
  market: TodayMarket;
  page: number;
  all: CandidatePage;
  filtered?: CandidatePage;
  fetching?: boolean;
  failure?: string | null;
  /** The today summary supplying the reference date failed to refresh. */
  allStale?: boolean;
  close: { phase: CloseScanPhase; strategies: number };
}): CandidateView {
  if (isTodayBatch(input.market, input.page))
    return {
      source: "today",
      rows: input.all.items,
      total: input.all.total,
      loading: false,
      error: null,
      warning: null,
      stale: Boolean(input.allStale),
      emptyMessage: emptyCandidateMessage({
        market: "all",
        total: input.all.total,
        close: input.close,
        stale: input.allStale,
      }),
    };
  if (!input.filtered)
    return input.failure
      ? {
          source: "error",
          rows: undefined,
          total: undefined,
          loading: false,
          error: input.failure,
          warning: null,
          stale: false,
          emptyMessage: null,
        }
      : {
          source: "pending",
          rows: undefined,
          total: undefined,
          loading: true,
          error: null,
          warning: null,
          stale: false,
          emptyMessage: PENDING_CANDIDATE_MESSAGE,
        };
  const stale = Boolean(input.failure) || Boolean(input.allStale);
  return {
    source: "filtered",
    rows: input.filtered.items,
    total: input.filtered.total,
    loading: false,
    error: null,
    warning: input.failure ?? null,
    stale,
    emptyMessage: emptyCandidateMessage({
      market: input.market,
      total: input.filtered.total,
      close: input.close,
      stale,
    }),
  };
}

/**
 * The A-share close-scan wording only describes cn-equity sources; a crypto
 * empty table uses neutral wording so it does not claim A-share state.
 */
export function emptyCandidateMessage(input: {
  market: TodayMarket;
  total: number;
  close: { phase: CloseScanPhase; strategies: number };
  /** The empty result predates a failed refresh; do not call it confirmed. */
  stale?: boolean;
}): string {
  if (input.total > 0) return "本页无候选；请返回上一页。";
  // An old zero followed by a failed refresh cannot claim a completed scan.
  if (input.stale)
    return "最近一次成功读取无候选；其后刷新失败，当前空表不代表无信号。";
  if (input.market === "crypto")
    return "数字货币当前无入选候选；空表不代表无信号，数据就绪与策略启用情况见下方。";
  const { phase, strategies } = input.close;
  if (strategies === 0) return "未启用 A 股策略；空表不是无信号。";
  if (phase === "complete")
    return "最近收盘扫描已完成，无入选候选；流程结束不代表行情完整或无信号，数据缺口与就绪状态见下方。";
  if (phase === "running")
    return "收盘扫描进行中；结果尚未确认，空表不代表无信号。";
  if (phase === "missed")
    return "最近收盘扫描未在截止前完成，不补跑；空表不代表无信号。";
  if (phase === "unknown-date")
    return "基准交易日未知：交易日历或本地日线待核验；空表不代表无信号。";
  return "最近收盘扫描等待或未确认；空表不代表无信号。";
}

/** Risk first, then only a total data outage sends the user to /system. */
export function dailyMainAction(input: {
  risks: number;
  equityReady: boolean;
  cryptoReady: boolean;
  candidates: number;
}): { href: string; text: string } {
  if (input.risks > 0)
    return { href: "#holding-risk", text: `处理 ${input.risks} 个跌破止损` };
  if (!input.equityReady && !input.cryptoReady)
    return { href: "/system", text: "补齐数据" };
  return {
    href: "#tomorrow",
    text: input.candidates > 0 ? `查看 ${input.candidates} 个候选` : "查看候选",
  };
}
